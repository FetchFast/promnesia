/* @flow */

import type {Locator, Tag, Url, Second} from './common';
import {Visit, Visits, Blacklisted, unwrap, Methods, ldebug, linfo, lerror, lwarn} from './common';
import {normaliseHostname} from './normalise';
import {get_options_async, setOptions} from './options';
import {chromeTabsExecuteScriptAsync, chromeTabsInsertCSS, chromeTabsQueryAsync, chromeRuntimeGetPlatformInfo} from './async_chrome';
import {showTabNotification, showBlackListedNotification, showIgnoredNotification, defensify, notify} from './notifications';
// $FlowFixMe
import reqwest from 'reqwest';

const ACTIONS: Array<chrome$browserAction | chrome$pageAction> = [
    chrome.browserAction,

    // chrome.pageAction,
    // eh, on mobile neither pageAction nor browserAction have setIcon? so using pageAction has no benefits basically..

    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Differences_between_desktop_and_Android#User_interface
    // browser action support is under development??
]; // TODO dispatch depending on android/desktop?

function rawToVisits(vis): Visits {
    // TODO not sure, maybe we want to distinguish these situations..
    if (vis == null) {
        return new Visits([]);
    }

    // TODO filter errors? not sure.
    return new Visits(vis.map(v => {
        // TODO wonder if server is returning utc...
        // TODO server should return tz aware, probably...
        const dts = v['dt'] + ' UTC'; // jeez. seems like it's the easiest way...

        const dt: Date = new Date(dts);
        const vtags: Array<Tag> = v['tags']; // TODO hmm. backend is responsible for tag merging?
        const vourl: string = v['original_url'];
        const vnurl: string = v['normalised_url'];
        const vctx: ?string = v['context'];
        const vloc: ?Locator = v['locator']
        const vdur: ?Second = v['duration'];
        return new Visit(vourl, vnurl, dt, vtags, vctx, vloc, vdur);
    }));
}


// TODO definitely need to use something very lightweight for json requests..

async function queryBackendCommon(params, endp: string) {
    const opts = await get_options_async();
    const endpoint = `${opts.host}/${endp}`;
    // TODO reqwest logging??
    const response = await reqwest({
        url: endpoint,
        method: 'post',
        contentType: 'application/json',
        headers: {
            'Authorization': "Basic " + btoa(opts.token),
        },
        data: JSON.stringify(params)
    });
    ldebug(`success: ${response}`);
    return response;
}

async function getBackendVisits(u: Url) {
    return queryBackendCommon({url: u}, 'visits').then(rawToVisits);
}


// TODO include browser too?
export async function searchVisits(u: Url): Promise<Visits> {
    return queryBackendCommon({url: u}, 'search').then(rawToVisits);
}

export async function searchAround(timestamp: number): Promise<Visits> {
    return queryBackendCommon({timestamp: timestamp}, 'search_around').then(rawToVisits);
}

function getDelayMs(/*url*/) {
    return 10 * 60 * 1000; // TODO do something smarter... for some domains we want it to be without delay
}

const LOCAL_TAG = 'local';


async function getChromeVisits(url: Url): Promise<Visits> {
    // $FlowFixMe
    if (!chrome.history) {
        // ugh. 'history' api is not supported on mobile (TODO mention that in readme)
        // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Differences_between_desktop_and_Android#Other_UI_related_API_and_manifest.json_key_differences
        return new Visits([]);
    }

    // $FlowFixMe
    const results = await new Promise((cb) => chrome.history.getVisits({url: url}, cb));

    // without delay you will always be seeing it as visited
    // but could be a good idea to make it configurable; e.g. sometimes we do want to know immediately. so could do domain-based delay or something like that?
    const delay = getDelayMs();
    const current = new Date();

    // ok, visitTime returns epoch which gives the correct time combined with new Date

    const times: Array<Date> = results.map(r => new Date(r['visitTime'])).filter(dt => current - dt > delay);
    // TODO FIXME not sure if need to normalise..
    const visits = times.map(t => new Visit(url, url, t, [LOCAL_TAG]));
    return new Visits(visits);
}

type Reason = string;

function normalisedHostname(url: Url): string {
    const _hostname = new URL(url).hostname;
    const hostname = normaliseHostname(_hostname);
    return hostname;
}

async function isBlacklisted(url: Url): Promise<?Reason> {
    // TODO perhaps use binary search?
    const hostname = normalisedHostname(url);
    const opts = await get_options_async();
    // for now assumes it's exact domain match domain level
    if (opts.blacklist.includes(hostname)) {
        return "User-defined blacklist";
    }
    const domains_url = chrome.runtime.getURL('shallalist/finance/banking/domains');
    const resp = await fetch(domains_url);
    const domains = (await resp.text()).split('\n');
    if (domains.includes(hostname)) {
        return "'Banking' blacklist";
    }
    return null;
}

type Result = Visits | Blacklisted;

export async function getVisits(url: Url): Promise<Result> {
    const bl = await isBlacklisted(url);
    if (bl != null) {
        return new Blacklisted(url, bl);
    }
    // NOTE sort of a problem with chrome visits that they don't respect normalisation.. not sure if there is much to do with it
    const chromeVisits = await getChromeVisits(url);
    const backendVisits = await getBackendVisits(url);
    const allVisits = backendVisits.visits.concat(chromeVisits.visits);
    return new Visits(allVisits);
}

type IconStyle = {
    icon: string,
    title: string,
    text: ?string,
};


// TODO this can be tested?
function getIconStyle(visits: Result): IconStyle {
    if (visits instanceof Blacklisted) {
        return {icon: 'images/ic_blacklisted_48.png', title: `Blacklisted: ${visits.reason}`, text: null};
    }

    const vcount = visits.visits.length;
    if (vcount === 0) {
        return {icon: 'images/ic_not_visited_48.png', title: 'Not visited', text: null};
    }
    const contexts = visits.contexts();
    const ccount = contexts.length;
    if (ccount > 0) {
        return {icon: 'images/ic_visited_48.png'    , title: `${vcount} visits, ${ccount} contexts`, text: ccount.toString()};
    }
    // TODO a bit ugly, but ok for now.. maybe cut off by time?
    const boring = visits.visits.every(v => v.tags.length == 1 && v.tags[0] == LOCAL_TAG);
    if (boring) {
        // TODO not sure if worth distinguishing..
        return {icon: "images/ic_boring_48.png"     , title: `${vcount} visits (local only)`, text: null};
    } else {
        return {icon: "images/ic_blue_48.png"       , title: `${vcount} visits`, text: null};
    }
}

async function updateState (tab: chrome$Tab) {
    const url = unwrap(tab.url);
    const tabId = unwrap(tab.id);

    if (ignored(url)) {
        linfo("ignoring %s", url);
        return;
    }

    const platform = await chromeRuntimeGetPlatformInfo();

    const visits = await getVisits(url);
    let {icon, title, text} = getIconStyle(visits);
    for (const action of ACTIONS) {
        // $FlowFixMe
        action.setTitle({
            tabId: tabId,
            title: title,
        });

        // $FlowFixMe
        if (platform.os != 'android') {
            // $FlowFixMe
            action.setIcon({
                tabId: tabId,
                path: icon,
            });
            // $FlowFixMe
            action.setBadgeText({
                tabId: tabId,
                text: text,
            });
        }
    }
    // chrome.pageAction.show(tabId);

    if (visits instanceof Visits) {
            // TODO maybe store last time we showed it so it's not that annoying... although I definitely need js popup notification.
            const locs = visits.contexts().map(l => l == null ? null : l.title);
            if (locs.length !== 0) {
                await showTabNotification(tabId, `${locs.length} contexts!\n${locs.join('\n')}`);
            }

        await chromeTabsExecuteScriptAsync(tabId, {
            file: 'sidebar.js',
        });
        await chromeTabsExecuteScriptAsync(tabId, {
            code: `bindSidebarData(${JSON.stringify(visits)})`
        });
    }
}

// TODO check for blacklist here as well
// TODO FIXME ugh. this can be tested on some static page... I guess?
async function showDots(tabId) {
    // TODO can be tested
    const mresults = await chromeTabsExecuteScriptAsync(tabId, {
        code: `
     link_elements = document.getElementsByTagName("a");
{
     const urls = new Set([]);
     for (var i = 0; i < link_elements.length; i++) {
         urls.add(link_elements[i].getAttribute('href'));
     }
     urls.delete("#");
     urls.delete(null);
     const aurls = new Set([]);
     for (let u of urls) {
         if (u.startsWith('javascript')) {
             continue
         } else if (u.startsWith('/')) {
             aurls.add(document.domain + u);
         } else {
             aurls.add(u);
         }
     }
     // TODO move more stuff to background??
     Array.from(aurls)
}
 `
});
    const results = unwrap(mresults);
    // TODO FIXME filter these by blacklist as well?
    const res = unwrap(results[0]);
    // TODO check if zero? not sure if necessary...
    // TODO maybe, I need a per-site extension?

    const resp = await queryBackendCommon({
        urls: res,
    }, 'visited');

    // TODO ok, we received exactly same elements as in res. now what??
    // TODO cache results internally? At least for visited. ugh.
    // TODO make it custom option?
    const vis = {};
    for (var i = 0; i < res.length; i++) {
        vis[res[i]] = resp[i];
    }
    // TODO make a map from it..
    await chromeTabsInsertCSS(tabId, {
        code: `
.wereyouhere-visited:after {
  content: "⚫";
  color: #FF4500;
  vertical-align: super;
  font-size: smaller;

  user-select: none;

  position:absolute;
  z-index:100;
}
`
    });
    await chromeTabsExecuteScriptAsync(tabId, {
        code: `
vis = ${JSON.stringify(vis)}; // madness!
{
for (var i = 0; i < link_elements.length; i++) {
    const a_tag = link_elements[i];
    let url = a_tag.getAttribute('href');
    if (url == null) {
        continue;
    }
    if (url.startsWith('/')) {
        url = document.domain + url;
    }
    if (vis[url] == true) {
        // console.log("adding class to ", a_tag);
        a_tag.classList.add('wereyouhere-visited');
    }
}
}
`
    });
}

// ok, looks like this one was excessive..
// chrome.tabs.onActivated.addListener(updateState);

function ignored(url: string): boolean {
    // not sure why about:blank is loading like 5 times.. but this seems to fix it
    if (url.match('chrome://') != null || url.match('chrome-devtools://') != null || url == 'about:blank') {
        return true;
    }
    if (url === 'https://www.google.com/_/chrome/newtab?ie=UTF-8') { // ugh, not sure how to dix that properly
        return true;
    }
    return false;
}

/*
// TODO ehh... not even sure that this is correct thing to do...
// $FlowFixMe
chrome.webNavigation.onDOMContentLoaded.addListener(detail => {
    get_options(opts => {
        if (!opts.dots) {
            return;
        }
        const url = unwrap(detail.url);
        if (detail.frameId != 0) {
            ldebug('ignoring child iframe for %s', url);
            return;
        }

        if (ignored(url)) {
            ldebug("ignoring %s", url);
            return;
        }
        // https://kk.org/thetechnium/
        ldebug('finished loading DOM %s', detail);

        showDots(detail.tabId, opts);
        // updateState();
    });
});
*/

// chrome.tabs.onReplaced.addListener(updateState);

chrome.tabs.onCreated.addListener((tab) => {
    ldebug("onCreated %s", tab);
});


// $FlowFixMe
chrome.tabs.onUpdated.addListener(defensify(async (tabId, info, tab) => {
    delete tab.favIconUrl; // too spammy in logs
    ldebug("onUpdated %s %s", tab, info);

    const url = tab.url;
    if (url == null) {
        ldebug('onUpdated: ignoring as URL is not set');
        return;
    }

    if (ignored(url)) {
        linfo('onUpdated: ignored explicitly %s', url);
        return;
    }
    // right, tab updated triggered quite a lot, e.g. when the title is blinking
    // ok, so far there are basically two cases
    // 1. you open new tab. in that case 'url' won't be passed but onDomContentLoaded will be triggered
    // 2. you navigate within the same tab, e.g. on youtube. then url will be passed, but onDomContentLoaded doesn't trigger. TODO not sure if it's always the case. maybe it's only YT
    // TODO shit, so we might need to hide previous dots? ugh...

    // TODO vvvv these might need to be cleaned up; not sure how relevant...
    // page refresh: loading -> complete (no url at any point)
    // clicking on link: loading (url) -> complete
    // opening new link: loading -> loading (url) -> complete
    // ugh. looks like 'complete' is the most realiable???
    // but, I checked with 'complete' and sometimes it would reload many things with loading -> complete..... shit.

    // also if you, say, go to web.telegram.org it's gonna show multiple notifications due to redirect... but perhaps this can just be suppressed..

    if (info['status'] === 'complete') {
        linfo('requesting! %s', url);
        await updateState(tab);
    }
}));


async function getActiveTab(): Promise<chrome$Tab> {
    const tabs = await chromeTabsQueryAsync({'active': true});
    // TODO can it be empty at all??
    if (tabs.length > 1) {
        lwarn("Multiple active tabs: %s", tabs); // TODO handle properly?
    }
    const tab = tabs[0];
    return tab;
}

async function showActiveTabNotification(text: string, color: string): Promise<void> {
    const atab = await getActiveTab();
    await showTabNotification(unwrap(atab.id), text, color);
}

// $FlowFixMe
chrome.runtime.onMessage.addListener(async (msg) => { // TODO not sure if should defensify here?
    const method = msg.method;
    if (method == Methods.GET_SIDEBAR_VISITS) {
        const atab = await getActiveTab();
        const url = unwrap(atab.url);
        if (!ignored(url)) { // TODO shouldn't have been requested in the first place?
            const visits = await getVisits(unwrap(atab.url));
            if (visits instanceof Visits) {
                return visits;
            } else {
                // hmm. generally shouldn't happen, since sidebar is not bound on blacklisted urls
                lerror("Shouldn't have happened! %s", visits);
            }
        }
        // TODO err. not sure what's happening here...
        // if i'm using await in return type, it expects me to return visits instead of true/false??
        // is it automatically detecting whether it's a promise or not??
        // perhaps async automatically uncurries last argument?
        // could be Firefox only?
        // sendResponse(visits);
        // return true; // this is important!! otherwise message will not be sent?
    } else if (method == Methods.SEARCH_VISITS_AROUND) {
        const timestamp = msg.timestamp; // TODO FIXME epoch?? 
        const params = new URLSearchParams();
        // TODO str??
        params.append('timestamp', timestamp.toString());
        const search_url = chrome.extension.getURL('search.html') + '?' + params.toString();
        chrome.tabs.create({'url': search_url});
    } else if (method == Methods.SHOW_DOTS) {
        // TODO actually use show dots setting?
        // const opts = await get_options_async();
        const atab = await getActiveTab();
        const url = unwrap(atab.url);
        const tid = unwrap(atab.id);
        if (ignored(url)) {
            await showIgnoredNotification(tid, url);
        } else {
            const bl = await isBlacklisted(url);
            if (bl != null) {
                await showBlackListedNotification(tid, new Blacklisted(url, bl));
            } else {
                await showDots(tid);
            }
        }
    } else if (method == Methods.OPEN_SEARCH) {
        // TODO FIXME get current tab url and pass as get parameter?
        chrome.tabs.create({ url: "search.html" });
    }
    return false;
});


/*
   On android, clicking on icon in address bar doesn't seem to work.. however clicking in menu triggers this action?
   https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Differences_between_desktop_and_Android#User_interface

   popup is available for pageAction?? can use it for blacklisting/search?
*/
for (const action of ACTIONS) {
    // $FlowFixMe
    action.onClicked.addListener(defensify(async tab => {
        const url = unwrap(tab.url);
        const tid = unwrap(tab.id);
        if (ignored(url)) {
            // TODO tab notification?
            notify(`${url} can't be handled`);
            return;
        }
        const bl = await isBlacklisted(url);
        if (bl != null) {
            await showBlackListedNotification(tid, new Blacklisted(url, bl));
            // TODO show popup; suggest to whitelist?
        } else {
            await chromeTabsExecuteScriptAsync(tid, {file: 'sidebar.js'});
            await chromeTabsExecuteScriptAsync(tid, {code: 'toggleSidebar();'});
        }
    }));
}


// $FlowFixMe // err, complains at Promise but nevertheless works
chrome.commands.onCommand.addListener(defensify(async cmd => {
    if (cmd === 'show_dots') {
        chrome.runtime.sendMessage({ method: Methods.SHOW_DOTS });
    } else if (cmd === 'search') {
        chrome.runtime.sendMessage({ method: Methods.OPEN_SEARCH });
    } else {
        console.log.error("unexpected command %s", cmd);
    }
}));


async function blackListDomain(e): Promise<void> {
    const url = unwrap(e.pageUrl);
    const hostname = normalisedHostname(url);

    const opts = await get_options_async();
    opts.blacklist.push(hostname);

    const ll = opts.blacklist.length;
    await showActiveTabNotification(`Added ${hostname} to blacklist (${ll} items now)`, 'blue');
    await setOptions(opts);
}

chrome.contextMenus.create({
    'title'   : "Blacklist domain",
    // $FlowFixMe
    'onclick' : defensify(blackListDomain),
});

// TODO make sure it's consistent with rest of blacklisting and precedence clearly stated
// chrome.contextMenus.create({
//     "title"   : "Blacklist page",
//     // $FlowFixMe
//     "onclick" : blackListPage,
// });

// chrome.contextMenus.create({
//     "title"   : "Whitelist page",
//     "onclick" : clickHandler,
// });
