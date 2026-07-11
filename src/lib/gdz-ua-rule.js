/**
 * Build the GDZ User-Agent rule without chrome.* dependencies so Node tests can
 * import it. gdz-ru.com's DDoS-Guard accepts the okhttp UA, while MV3 fetch()
 * cannot set User-Agent directly. The extension-id initiator scope replaces a
 * static manifest rule that also rewrote normal-tab traffic to gdz-ru.com.
 */
export const GDZ_UA_RULE_ID = 1;

export function buildGdzUaRule(extensionId) {
  return {
    id: GDZ_UA_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'user-agent', operation: 'set', value: 'okhttp/4.9.1' }
      ]
    },
    condition: {
      urlFilter: '||gdz-ru.com/',
      initiatorDomains: [extensionId],
      resourceTypes: ['xmlhttprequest', 'image', 'media', 'other']
    }
  };
}
