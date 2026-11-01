import type { PrMark, PullRequest } from '../types'
import { parseRemote, plainText } from './issues'
import { cutTo, widthOf } from './text'

/** `gh pr list --limit`: more than this reads `100+`. */
export const PRS_LIMIT = 100
const MIN_TITLE = 12
const MARK_COLUMNS = 2 // the mark and the space after it, always kept

const FAILED_RUNS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PASSED_RUNS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const FAILED_STATES = new Set(['FAILURE', 'ERROR'])
const RUNNING_STATES = new Set(['PENDING', 'EXPECTED'])

/** Each mark's theme colour; `D` draws dim instead. */
export const MARK_COLOR: Record<'✗' | 'R' | '●' | '✓', string> = { '✗': 'error', R: 'merged', '●': 'warning', '✓': 'success' }

/** `owner/repo` for a github.com remote; nothing for any other host. */
export function prsRepoOf(url: string): string | undefined {
  const remote = parseRemote(url)
  return remote && `${remote.owner}/${remote.repo}`
}

type Check = 'failed' | 'running' | 'passed' | 'unknown'

/** One `statusCheckRollup` item: a StatusContext has `state`, a CheckRun `status` and `conclusion`. */
function checkOf(item: unknown): Check {
  if (typeof item !== 'object' || item === null) return 'unknown'
  const { state, status, conclusion } = item as { state?: unknown; status?: unknown; conclusion?: unknown }
  if (typeof state === 'string') {
    if (FAILED_STATES.has(state)) return 'failed'
    if (RUNNING_STATES.has(state)) return 'running'
    return state === 'SUCCESS' ? 'passed' : 'unknown'
  }
  if (typeof conclusion === 'string' && FAILED_RUNS.has(conclusion)) return 'failed'
  if (typeof status === 'string' && status !== 'COMPLETED') return 'running'
  return typeof conclusion === 'string' && PASSED_RUNS.has(conclusion) ? 'passed' : 'unknown'
}

/** The one mark a PR shows: `D > ✗ > R > ● > ✓ > ''`. Unknown checks are neither failed nor running. */
export function markOf(pr: { isDraft?: boolean; reviewDecision?: string | null; statusCheckRollup?: readonly unknown[] | null }): PrMark {
  if (pr.isDraft) return 'D'
  const checks = (pr.statusCheckRollup ?? []).map(checkOf)
  if (checks.includes('failed')) return '✗'
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'R'
  if (checks.includes('running')) return '●'
  return checks.includes('passed') ? '✓' : ''
}

/** `gh pr list --json number,title,isDraft,reviewDecision,statusCheckRollup,author,updatedAt,url`, newest first. Throws on anything but JSON. */
export function parsePrs(json: string): PullRequest[] {
  const raw = JSON.parse(json) as Array<{
    number: number
    title: string
    isDraft?: boolean
    reviewDecision?: string | null
    statusCheckRollup?: unknown[] | null
    author?: { login?: string } | null
    updatedAt: string
    url: string
  }>
  return raw
    .map(item => ({
      number: item.number,
      title: plainText(item.title),
      author: item.author?.login ?? '',
      mark: markOf(item),
      updatedAt: item.updatedAt,
      url: item.url,
    }))
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
}

/** The mark that colours the tab count: any failed PR, else any with changes requested. Drafts mark `D`, so never count. */
export function worstMark(prs: readonly PullRequest[]): '✗' | 'R' | undefined {
  if (prs.some(pr => pr.mark === '✗')) return '✗'
  return prs.some(pr => pr.mark === 'R') ? 'R' : undefined
}

/**
 * A PR row fitted to `width` columns: `#N `, the title, then the mark and the
 * age. The mark always stays; the age drops so the title keeps at least 12
 * columns; the title is cut with `…`.
 */
export function fitPrRow(pr: PullRequest, width: number, age: string) {
  const head = `#${pr.number} `
  const shownAge = age && head.length + MIN_TITLE + MARK_COLUMNS + widthOf(age) + 1 <= width ? age : ''
  const tail = MARK_COLUMNS + (shownAge ? widthOf(shownAge) + 1 : 0)

  return { head, title: cutTo(pr.title, width - head.length - tail), age: shownAge }
}
