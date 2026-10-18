# Website analytics

The official landing pages share one optional GA4 measurement. This does not
instrument the Mac app, Even app, installer, or relay. See the visitor-facing
[data handling explanation](privacy.md#official-website-analytics).

## Property and stream

Configured in the Google Analytics UI on October 18, 2026:

| Setting | Value |
| --- | --- |
| Property | Dot Link Website (`559385659`) |
| Web stream | Dot Link Official Website (`16152457909`) |
| Measurement ID | `G-30KE8ZRSL9` |
| Website | `https://yusukeit0.github.io/dot-link/` and its seven translated pages |
| Reporting time zone / currency | Bangkok, UTC+7 / JPY |
| Event and user retention | 14 months; user retention resets on new activity |
| Enhanced measurement | Page views, scrolls, outbound clicks |
| Disabled enhanced features | Site search, forms, automatic video, file downloads |
| Advertising | Google signals and user-provided data off; ad personalization disallowed in all regions; no ad links |
| Key event | `install_click`, once per event, no default monetary value |
| Custom dimension | `site_lang`, event scope, parameter `site_lang` |
| Internal filter | Exclude `traffic_type` exactly `internal`, Active |
| Search Console | Matching URL-prefix property linked to this stream |

The measurement ID is public configuration, not a credential. Do not publish
account screenshots containing private account details or raw visitor data.

## Event contract

The Google tag configuration supplies `site_lang` to automatic events, and each
custom event supplies it explicitly. Values are `en`, `ja`, `zh-Hant`, `zh-Hans`,
`ko`, `ar`, `fr`, and `de`; they describe the page, not browser language or country.

| Event | Trigger | Additional parameters |
| --- | --- | --- |
| `install_click` | Even Hub link in hero or footer | `cta_id=install`, `placement=hero` or `footer` |
| `cta_click` | Quickstart link or hero video anchor | `cta_id=quickstart`, `placement=hero` or `setup`; or `cta_id=watch`, `placement=hero` |
| `language_switch` | Link to another page language | `target_lang`; `site_lang` remains the source language |
| `video_start` | First measured HTML video `playing` event on a page | `video_id=dot-link-introduction` |
| `video_complete` | First `ended` event after a measured start on that page | Same `video_id` |

An install click is an outbound intention, not installation completion. An ended
video may have been seeked; this event does not certify full viewing. Pausing,
resuming, or replaying does not add another start/complete on the same page.
Actions before consent are not buffered or replayed. A video already playing when
consent is granted needs a subsequent `playing` event to register its start.

Enhanced outbound `click` events are separate from the custom CTA events; do not
sum them as independent conversions. The hero video anchor records navigation to
the video, while `video_start` records actual playback. Links keep native navigation.

The module accepts only the production origin and known page/language pairs.
Local previews never load the Google tag. The configured page URL omits query and
fragment; referral URLs retain only origin or a known official language path.
Public UTM slugs support source, medium, campaign, and content, each up to 80
lowercase letters, digits, underscores, or hyphens. Do not put private data in UTMs.

## Browser exclusion

After deployment, open [Analytics settings](https://yusukeit0.github.io/dot-link/#analytics-settings)
in the browser/profile to exclude and check **Exclude this browser from reports**.
The equivalent control is translated on each page. The local preference is shared
across language pages and survives navigation/restarts; clearing site data removes it.
It does not follow a Google account, another browser profile, or another device.
No IP exclusion rule is used. A localhost choice does not configure the public site.

With consent, internal visits are sent with `traffic_type=internal` for the active
GA filter to exclude. Rejecting analytics prevents sending altogether. Excluded
events are not recoverable in reports. Google documents that filter changes can
take 24–36 hours; see [internal traffic filtering](https://support.google.com/analytics/answer/10104470).

## Deployment and receipt check

PR checks build the Pages artifact. They do not publish it. Merge and the main
branch's **Introduction page** workflow deployment require the maintainer's separate
instruction. The settings above alone do not demonstrate event receipt.

After the authorized deployment, the analyst should:

1. Use a test browser/profile with internal exclusion **off** and open a language
   page. Before allowing analytics, verify that no Google analytics script or
   collection requests appear. Reject and reload: the site remains usable with no
   analytics requests.
2. Allow analytics and use Google Tag Assistant to enable debugging. Check the
   intended measurement ID, one page view, and `site_lang` in the network payload
   and GA4 DebugView. Check automatic scroll/outbound events as well as custom ones.
3. Click both install placements, both Quickstart placements, the video anchor,
   and a different language. Verify the names/parameters above and source language.
   The destination page view must use the destination language.
4. Play, pause/resume, finish, and replay the video. Expect one start and one
   complete per page. Reload for an independent repeat.
5. In settings, reject analytics and confirm the reload, stopped collection, and
   removal of this site's `dotlink_ga` cookies. Changing a choice in a second tab
   must stop a previously consenting open page as well.
6. After the receipt checks, enable exclusion on the maintainer's ordinary browser
   and confirm the checked control persists after reload. With consent enabled,
   inspect the outgoing internal marker; do not expect filtered traffic to establish
   normal report receipt. Verify exclusion after the filter propagation interval.

Record the deployed commit, language, test time, observed events and parameters,
and failures/unknowns in the PR. Do not attach identifying cookie values or visitor
payloads. Local tests establish consent/event behavior against a simulated browser;
they do not establish Google ingestion. See [Google's verification guide](https://developers.google.com/analytics/devguides/collection/ga4/troubleshoot).
