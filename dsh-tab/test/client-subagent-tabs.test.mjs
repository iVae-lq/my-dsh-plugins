import assert from 'node:assert/strict'
import test from 'node:test'
import { mountTabs, plain } from './helpers/client-harness.mjs'

// 官方会话目录里，子智能体 / 团队成员是 origin: "subagent" 的行，parentId 指向直接父会话。
const lead = { id: 'lead', title: 'Lead session' }
const other = { id: 'other', title: 'Other session' }
const sub = { id: 'sub', title: 'Sub-agent', origin: 'subagent', parentId: 'lead' }
const nested = { id: 'nested', title: 'Sub-sub-agent', origin: 'subagent', parentId: 'sub' }
const mate = { id: 'mate', title: 'Teammate', origin: 'subagent', parentId: 'lead' }

const tabsStorage = (ids, pinned = []) => ({ 'dsh.tab.view.v2': { tabs: ids, pinned } })

test('opening a sub-agent from a lead session does not add a tab and the lead tab stays selected', () => {
  const ui = mountTabs({ sessions: [lead, sub], current: 'lead' })
  assert.deepEqual(ui.tabIds(), ['lead'])

  ui.open('sub')

  assert.deepEqual(ui.tabIds(), ['lead'], 'no tab for the sub-agent session')
  assert.deepEqual(ui.activeTabIds(), ['lead'], 'the lead tab is the selected one while its sub-agent is open')
  assert.deepEqual(ui.errors(), [])
})

test('agent-team teammates and nested sub-agents resolve to the lead tab too', () => {
  const ui = mountTabs({ sessions: [lead, sub, nested, mate], current: 'lead' })

  ui.open('mate')
  assert.deepEqual(ui.tabIds(), ['lead'])
  assert.deepEqual(ui.activeTabIds(), ['lead'])

  ui.open('nested')
  assert.deepEqual(ui.tabIds(), ['lead'], 'a sub-agent of a sub-agent still belongs to the top-level session')
  assert.deepEqual(ui.activeTabIds(), ['lead'])
})

test('the parent is also found through the lead session subagentCatalog when the row has no parentId', () => {
  const orphan = { id: 'orphan', title: 'No parentId', origin: 'subagent' }
  const projections = { lead: { values: { subagentCatalog: [{ id: 'orphan' }] } } }
  const ui = mountTabs({ sessions: [lead, orphan], current: 'lead', projections })

  ui.open('orphan')

  assert.deepEqual(ui.tabIds(), ['lead'])
  assert.deepEqual(ui.activeTabIds(), ['lead'])
})

test('a sub-agent whose parent cannot be resolved gets no tab of its own and does not throw', () => {
  const orphan = { id: 'orphan', title: 'Unknown parent', origin: 'subagent' }
  const ui = mountTabs({ sessions: [lead, orphan], current: 'lead' })

  ui.open('orphan')

  assert.deepEqual(ui.tabIds(), ['lead'])
  assert.deepEqual(ui.activeTabIds(), [])
  assert.deepEqual(ui.errors(), [])
})

test('a sub-agent tab left behind by an older version is cleaned up on load', () => {
  const ui = mountTabs({
    sessions: [lead, other, sub],
    current: 'lead',
    storage: tabsStorage(['lead', 'sub', 'other']),
  })

  assert.deepEqual(ui.tabIds(), ['lead', 'other'])
  assert.deepEqual(plain(ui.storedTabs().tabs), ['lead', 'other'], 'and it is removed from the persisted list too')
})

test('opening a sub-agent as the very first thing still gives the lead a tab', () => {
  const ui = mountTabs({ sessions: [lead, sub], current: 'sub' })

  assert.deepEqual(ui.tabIds(), ['lead'])
  assert.deepEqual(ui.activeTabIds(), ['lead'])
})

test('ordinary sessions still get a tab when they are opened', () => {
  const ui = mountTabs({ sessions: [lead, other, sub], current: 'lead' })

  ui.open('other')

  assert.deepEqual(ui.tabIds(), ['lead', 'other'])
  assert.deepEqual(ui.activeTabIds(), ['other'])
})

test('clicking the selected lead tab while viewing its sub-agent changes nothing', () => {
  const ui = mountTabs({ sessions: [lead, sub], current: 'lead' })
  ui.open('sub')
  ui.clearOpenCalls()

  ui.click('lead')

  assert.deepEqual(ui.openCalls(), [])
  assert.equal(ui.currentId(), 'sub')
})

test('switching away from a tab and back returns to the sub-agent you were viewing', () => {
  const address = { parentSessionId: 'lead', childSessionId: 'sub', mode: 'continuable' }
  const ui = mountTabs({
    sessions: [lead, other, sub],
    current: 'lead',
    storage: tabsStorage(['lead', 'other']),
    bindings: { sub: address },
  })
  ui.open('sub')

  ui.click('other')
  assert.equal(ui.currentId(), 'other')
  assert.deepEqual(ui.activeTabIds(), ['other'])

  ui.clearOpenCalls()
  ui.click('lead')

  assert.deepEqual(ui.openCalls(), [address], 'the sub-agent address (with its mode) is reopened, not the lead')
  assert.equal(ui.currentId(), 'sub')
  assert.deepEqual(ui.activeTabIds(), ['lead'])
  assert.deepEqual(ui.tabIds(), ['lead', 'other'])
})

test('without a binding address the sub-agent session id is reopened', () => {
  const ui = mountTabs({ sessions: [lead, other, sub], current: 'lead', storage: tabsStorage(['lead', 'other']) })
  ui.open('sub')
  ui.click('other')
  ui.clearOpenCalls()

  ui.click('lead')

  assert.deepEqual(ui.openCalls(), ['sub'])
})

test('going back to the lead inside the tab makes the tab return to the lead next time', () => {
  const ui = mountTabs({ sessions: [lead, other, sub], current: 'lead', storage: tabsStorage(['lead', 'other']) })
  ui.open('sub')
  ui.open('lead') // 会话页里的「回到主会话」
  ui.click('other')
  ui.clearOpenCalls()

  ui.click('lead')

  assert.deepEqual(ui.openCalls(), ['lead'])
})

test('each tab remembers its own sub-agent', () => {
  const lead2 = { id: 'lead2', title: 'Second lead' }
  const sub2 = { id: 'sub2', title: 'Second sub-agent', origin: 'subagent', parentId: 'lead2' }
  const ui = mountTabs({
    sessions: [lead, lead2, sub, sub2],
    current: 'lead',
    storage: tabsStorage(['lead', 'lead2']),
  })
  ui.open('sub')
  ui.click('lead2')
  ui.open('sub2')

  ui.clearOpenCalls()
  ui.click('lead')
  assert.deepEqual(ui.openCalls(), ['sub'])

  ui.clearOpenCalls()
  ui.click('lead2')
  assert.deepEqual(ui.openCalls(), ['sub2'])
  assert.deepEqual(ui.tabIds(), ['lead', 'lead2'])
})

test('a remembered sub-agent that no longer exists falls back to the lead session', () => {
  const ui = mountTabs({ sessions: [lead, other, sub], current: 'lead', storage: tabsStorage(['lead', 'other']) })
  ui.open('sub')
  ui.click('other')
  ui.setRows([lead, other]) // 子智能体会话被删除了
  ui.clearOpenCalls()

  ui.click('lead')

  assert.deepEqual(ui.openCalls(), ['lead'])
})

test('closing the lead tab while viewing its sub-agent moves on to a neighbouring tab', () => {
  const ui = mountTabs({ sessions: [lead, other, sub], current: 'lead', storage: tabsStorage(['lead', 'other']) })
  ui.open('sub')
  ui.clearOpenCalls()

  ui.close('lead')

  assert.deepEqual(ui.openCalls(), ['other'])
  assert.deepEqual(ui.tabIds(), ['other'])
  assert.deepEqual(ui.activeTabIds(), ['other'])
})

test('closing another tab while viewing a sub-agent keeps the view where it is', () => {
  const ui = mountTabs({ sessions: [lead, other, sub], current: 'lead', storage: tabsStorage(['lead', 'other']) })
  ui.open('sub')
  ui.clearOpenCalls()

  ui.close('other')

  assert.deepEqual(ui.openCalls(), [])
  assert.equal(ui.currentId(), 'sub')
  assert.deepEqual(ui.tabIds(), ['lead'])
  assert.deepEqual(ui.activeTabIds(), ['lead'])
})

test('a closed lead tab does not come back because its sub-agent is still on screen', () => {
  const ui = mountTabs({
    sessions: [lead, other, sub],
    current: 'lead',
    storage: tabsStorage(['lead', 'other']),
    navigate: false, // 官方导航还没完成：主视图仍停在子智能体上
  })
  ui.open('sub')

  ui.close('lead')

  assert.deepEqual(ui.tabIds(), ['other'], 'the closed tab is suppressed while navigation is in flight')
})
