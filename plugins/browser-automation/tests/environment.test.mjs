import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ASK_USER, CHROME_INSTALL_REMEDY, STP_REMOTE_AUTOMATION_REMEDY, environmentRemedy } from '../environment.mjs'
import { explainFailure } from '../curated-tools.mjs'

// The exact texts seen on alpha (2026-09-18) before the apps / settings were in place.
const STP_CODE_6 = 'safari_get_page_content: server tool navigate_to_url failed: Tool error: Error Domain=WebDriverErrorDomain Code=6 "Could not create a session: You must enable \'Allow remote automation\' in the Developer section of Safari Settings to control Safari via WebDriver."'
const CHROME_TARGET_CLOSED = 'chrome_get_page_content: Chrome could not open https://example.com: Protocol error (Target.setDiscoverTargets): Target closed'

describe('environmentRemedy', () => {
  it('turns the STP remote-automation refusal into a user instruction naming the setting', () => {
    const remedy = environmentRemedy('safari', STP_CODE_6)
    assert.equal(remedy, STP_REMOTE_AUTOMATION_REMEDY)
    assert.match(remedy, /Develop ▸ Developer Settings/)
    assert.match(remedy, /Allow Remote Automation/)
    assert.ok(remedy.startsWith(ASK_USER))
  })

  it('reads a launch-time Target closed on a Chrome that never served a window as an environment problem', () => {
    const remedy = environmentRemedy('chrome', CHROME_TARGET_CLOSED, { everOpened: false })
    assert.ok(remedy !== undefined)
    assert.ok(remedy.startsWith(ASK_USER))
    // Either Chrome is absent (install it) or present but stuck on first launch (open it once by hand).
    assert.ok(remedy === CHROME_INSTALL_REMEDY || /Open Google Chrome once by hand/.test(remedy))
  })

  it('leaves a Target closed on a Chrome that has worked before to the ordinary page-gone hint', () => {
    assert.equal(environmentRemedy('chrome', CHROME_TARGET_CLOSED, { everOpened: true }), undefined)
  })

  it('is not fooled by ordinary tool errors', () => {
    assert.equal(environmentRemedy('safari', 'safari_click: no element matches "#nope"'), undefined)
    assert.equal(environmentRemedy('chrome', 'chrome_click: Element uid 1_4 not found on page', { everOpened: true }), undefined)
  })
})

describe('explainFailure with an environment problem', () => {
  it('replaces the raw WebDriver text with the unavailable + remedy message, keeping the original as context', () => {
    const explained = explainFailure('safari_get_page_content', { url: 'https://example.com' }, new Error(STP_CODE_6), {}, 60000)
    assert.match(explained.message, /^safari_get_page_content: Safari automation is unavailable on this machine\./)
    assert.match(explained.message, /tick "Allow Remote Automation"/)
    assert.match(explained.message, /underlying error: .*WebDriverErrorDomain Code=6/)
  })

  it('keeps ordinary failures on the existing hint path', () => {
    const explained = explainFailure('chrome_click', { uid: '1_4' }, new Error('chrome_click: Element uid 1_4 not found on page'), {}, 60000, { chromeEverOpened: true })
    assert.match(explained.message, /Hint: uids come from chrome_snapshot/)
  })
})
