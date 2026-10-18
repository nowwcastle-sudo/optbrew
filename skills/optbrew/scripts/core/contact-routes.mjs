import { shownPhones } from './facts.mjs';
import { anchorTexts } from './html.mjs';
import { sameSite } from './page-select.mjs';

const SCHEMES = { 'tel:': 'tel_link', 'sms:': 'sms_link', 'mailto:': 'mailto_link' };
/** The messenger and booking pages Korean small businesses take inquiries on: KakaoTalk channel and open chat, Naver TalkTalk and Naver booking. */
const CHANNEL_HOSTS = { 'pf.kakao.com': 'kakao_channel', 'open.kakao.com': 'kakao_open_chat', 'talk.naver.com': 'naver_talktalk',
  'booking.naver.com': 'naver_booking', 'm.booking.naver.com': 'naver_booking' };
const INQUIRY = /문의|상담|예약|contact|inquir|enquir|booking|reservation/i;
const WEB = ['http:', 'https:'];
const decodedPath = url => { try { return decodeURIComponent(url.pathname); } catch { return url.pathname; } };

/**
 * The ways a visitor can get in touch that one page's markup offers, each `{ kind, value }`: a tel:, sms: or mailto: link, a phone
 * number the page shows, a link to a KakaoTalk or Naver TalkTalk channel or to Naver booking, and a link within the site whose text
 * or path names an inquiry, consultation or booking page. `pageUrl` is where the page was served, for its relative links.
 */
export function contactRoutes(html, pageUrl) {
  const page = new URL(pageUrl);
  const routes = [];
  for (const { href, label } of anchorTexts(html, pageUrl)) {
    const url = new URL(href);
    const kind = SCHEMES[url.protocol] ?? (WEB.includes(url.protocol) ? CHANNEL_HOSTS[url.hostname.toLowerCase()] ??
      (sameSite(url, page) && (INQUIRY.test(label) || INQUIRY.test(decodedPath(url))) ? 'inquiry_page' : null) : null);
    if (kind) routes.push({ kind, value: href });
  }
  for (const phone of shownPhones(html)) routes.push({ kind: 'shown_phone', value: phone });
  return routes;
}
