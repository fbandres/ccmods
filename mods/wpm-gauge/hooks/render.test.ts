import { expect, test } from 'claude-code/testing'

const HINT = { component: 'PromptHint', props: { isDraft: true, isWorking: false, hint: '? for shortcuts' } } as const

test('draws an empty gauge while drafting at 0 WPM', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'wpm-gauge', surface, ...HINT })
    expect(await ui.find({ type: 'Text', text: /0 WPM/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '▱▱▱▱▱' })).toBeDefined()
    await ui.unmount()
  }
})

test('stays visible when idle with an empty prompt', async $ => {
  const ui = await $.ui.mount({
    plugin: 'wpm-gauge',
    surface: 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
  })
  expect(await ui.find({ type: 'Text', text: /0 WPM/ })).toBeDefined()
  await ui.unmount()
})
