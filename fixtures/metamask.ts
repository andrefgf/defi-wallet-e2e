import { testWithSynpress } from '@synthetixio/synpress'
import { metaMaskFixtures } from '@synthetixio/synpress/playwright'
import basicSetup from '../wallet-setup/basic.setup'

/**
 * Reusable `testWithMetaMask` fixture.
 *
 * `metaMaskFixtures(basicSetup)` wires the cached wallet browser and exposes a
 * ready-to-use `metamask` instance plus `metamaskPage`, `extensionId`, and the
 * usual Playwright fixtures (`context`, `page`). Specs import `test`/`expect`
 * from here so the wallet layer stays in one place.
 *
 * Usage:
 *   import { test, expect } from '../fixtures/metamask'
 *   test('…', async ({ page, metamask }) => { … })
 */
export const test = testWithSynpress(metaMaskFixtures(basicSetup))

export const expect = test.expect
