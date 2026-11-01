import type { Issue } from '../types'
import { cutTo, widthOf } from './text'

/** `gh issue list --limit`: more than this reads `100+`. */
export const ISSUES_LIMIT = 100
const LABEL_COLUMNS = 10
const MIN_TITLE = 12

const GITHUB_REMOTE = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/

/** The owner and repo of a github.com remote URL; nothing for any other host. */
export function parseRemote(url: string): { owner: string; repo: string } | undefined {
  const [, owner, repo] = GITHUB_REMOTE.exec(url.trim()) ?? []
  return owner && repo ? { owner, repo } : undefined
}

/** `owner/repo-issues` for a project's remote; nothing when it is not GitHub or already an issues repo. */
export function issuesRepoOf(url: string): string | undefined {
  const remote = parseRemote(url)
  if (!remote || remote.repo.endsWith('-issues')) return undefined
  return `${remote.owner}/${remote.repo}-issues`
}

/**
 * Text from gh made safe for one terminal row: control characters (C0, DEL,
 * C1, so no escape sequence can start) and runs of whitespace become one space;
 * bidi controls (which can reorder what the row shows) and zero-width
 * characters go.
 */
export function plainText(text: string | undefined) {
  return (text ?? '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ')
    .trim()
}

/** `gh issue list --json number,title,labels,updatedAt,url` output. Throws on anything but JSON. */
export function parseIssues(json: string): Issue[] {
  const raw = JSON.parse(json) as Array<{ number: number; title: string; labels?: Array<{ name: string }>; updatedAt: string; url: string }>
  return raw.map(item => {
    const label = plainText(item.labels?.[0]?.name)
    return {
      number: item.number,
      title: plainText(item.title),
      ...(label ? { label } : {}),
      updatedAt: item.updatedAt,
      url: item.url,
    }
  })
}

export type GhFailure = 'logged-out' | 'not-found' | 'temporary'

/** Why a gh call failed, from its stderr: only logged-out and not-found are final. */
export function classifyGhFailure(stderr: string): GhFailure {
  if (/gh auth login|not logged in|authentication/i.test(stderr)) return 'logged-out'
  if (/Could not resolve to a Repository|HTTP 404|Not Found/.test(stderr)) return 'not-found'
  return 'temporary'
}

/** How long ago `iso` was, short: `now`, `5m`, `2h`, `3d`, `2w`, `4mo`, `1y`. Blank when unreadable. */
export function ageOf(iso: string, now: number): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  if (days < 30) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}

/**
 * An issue row fitted to `width` columns: `#N `, the title, then the label
 * and the age, each after a space. The label drops first, then the age, so
 * the title keeps at least 12 columns; the title is cut with `…`.
 */
export function fitIssueRow(issue: Issue, width: number, age: string) {
  const head = `#${issue.number} `
  let label = issue.label ? cutTo(issue.label, LABEL_COLUMNS) : ''
  let shownAge = age
  const tail = () => (label ? widthOf(label) + 1 : 0) + (shownAge ? widthOf(shownAge) + 1 : 0)
  if (label && head.length + MIN_TITLE + tail() > width) label = ''
  if (shownAge && head.length + MIN_TITLE + tail() > width) shownAge = ''

  return { head, title: cutTo(issue.title, width - head.length - tail()), label, age: shownAge }
}
