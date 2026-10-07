const MIN_AGE_MONTHS = 6
const CRITERIA_URL = 'https://github.com/XargsUK/awesome-adhd/blob/main/CONTRIBUTING.md'
const FORM_URL = 'https://github.com/XargsUK/awesome-adhd/issues/new?template=resource-suggestion.yml'
const ALL_FORMS_URL = 'https://github.com/XargsUK/awesome-adhd/issues/new/choose'
const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json'
const REQUEST_HEADERS = {
  Accept: 'application/rdap+json, application/json',
  'User-Agent': 'awesome-adhd-triage (https://github.com/XargsUK/awesome-adhd)',
}

const REQUIRED_SECTIONS = ['Resource name', 'Links', 'First public release date', 'Pricing', 'Your connection to it']
const REPORT_SECTION = 'which entry or page'
const SITE_FORM_TITLE = /^(Quick|Detailed) Suggestion: /
const MAINTAINER_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR']

// A registration date for these says nothing about the resource hosted on them.
const SHARED_HOSTS = [
  'apple.com', 'google.com', 'github.com', 'github.io', 'gitlab.com', 'microsoft.com', 'mozilla.org',
  'youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com', 'facebook.com', 'x.com', 'twitter.com',
  'reddit.com', 'discord.gg', 'discord.com', 't.me', 'spotify.com', 'medium.com', 'substack.com',
  'vercel.app', 'netlify.app', 'pages.dev', 'web.app', 'firebaseapp.com', 'notion.site', 'itch.io',
]

function parseSections(body) {
  const sections = new Map()
  const parts = (body || '').split(/^#{2,3}[ \t]+(.+?)[ \t]*$/m)
  for (let i = 1; i < parts.length; i += 2) {
    const text = parts[i + 1].trim()
    sections.set(parts[i].toLowerCase(), text === '_No response_' ? '' : text)
  }
  return sections
}

function parseUrls(text) {
  const urls = []
  for (const raw of text.match(/https?:\/\/[^\s<>()[\]"'`]+/g) || []) {
    try {
      urls.push(new URL(raw.replace(/[.,;:!?]+$/, '')))
    } catch {
      continue
    }
  }
  return urls
}

function linkUrls(sections) {
  return [...sections]
    .filter(([heading]) => /\b(links?|urls?)\b/.test(heading))
    .flatMap(([, text]) => parseUrls(text))
}

function hostOf(url) {
  return url.hostname.toLowerCase().replace(/^www\./, '')
}

function appStoreId(url) {
  return hostOf(url) === 'apps.apple.com' ? url.pathname.match(/\/id(\d+)/)?.[1] : undefined
}

function githubRepo(url) {
  if (hostOf(url) !== 'github.com') return undefined
  const [owner, repo] = url.pathname.split('/').filter(Boolean)
  return owner && repo && /^[\w.-]+$/.test(owner + repo) ? { owner, repo: repo.replace(/\.git$/, '') } : undefined
}

function isSharedHost(host) {
  return SHARED_HOSTS.some((shared) => host === shared || host.endsWith(`.${shared}`))
}

function resourceKey(url) {
  const storeId = appStoreId(url)
  if (storeId) return `appstore:${storeId}`
  if (hostOf(url) === 'play.google.com') return `play:${url.searchParams.get('id')}`
  return `${hostOf(url)}${url.pathname.replace(/\/+$/, '')}`.toLowerCase()
}

function classify(issue, sections) {
  const maintainer = MAINTAINER_ASSOCIATIONS.includes(issue.author_association)
  if (maintainer && SITE_FORM_TITLE.test(issue.title)) return 'site'
  if (maintainer || sections.has(REPORT_SECTION)) return 'ignore'
  if (REQUIRED_SECTIONS.every((name) => sections.has(name.toLowerCase()))) return 'form'
  return sections.has('resource name') ? 'old-template' : 'bypass'
}

function parseDeclaredDate(text) {
  const match = (text || '').match(/\b(\d{4})-(\d{2})(?:-(\d{2}))?\b/)
  const date = match ? new Date(`${match[1]}-${match[2]}-${match[3] || '01'}T00:00:00Z`) : new Date(NaN)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function addMonths(date, months) {
  const result = new Date(date)
  result.setUTCMonth(result.getUTCMonth() + months)
  return result
}

function formatDate(date) {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000), headers: REQUEST_HEADERS })
    return response.ok ? await response.json() : undefined
  } catch {
    return undefined
  }
}

async function appStoreRelease(id) {
  const data = await fetchJson(`https://itunes.apple.com/lookup?id=${id}`)
  const released = data?.results?.[0]?.releaseDate
  return released ? { firm: true, date: new Date(released), claim: `The App Store gives the release date as ${formatDate(new Date(released))}` } : undefined
}

async function repoCreation(github, { owner, repo }) {
  try {
    const { data } = await github.rest.repos.get({ owner, repo })
    const created = new Date(data.created_at)
    return { firm: true, date: created, claim: `The repository ${data.full_name} was created on ${formatDate(created)}` }
  } catch {
    return undefined
  }
}

// Registries only answer for registrable domains, so walk up from the full host until one resolves.
async function domainRegistration(host, bootstrap) {
  const labels = host.split('.')
  const server = bootstrap?.services?.find(([tlds]) => tlds.includes(labels.at(-1)))?.[1]?.[0]
  if (!server) return undefined
  for (let start = 0; labels.length - start >= 2; start++) {
    const domain = labels.slice(start).join('.')
    const data = await fetchJson(`${server}domain/${encodeURIComponent(domain)}`)
    const registered = data?.events?.find((event) => event.eventAction === 'registration')?.eventDate
    if (registered) {
      return { date: new Date(registered), claim: `The domain ${domain} was registered on ${formatDate(new Date(registered))}` }
    }
  }
  return undefined
}

async function independentEvidence(github, urls) {
  const hosts = urls.filter((url) => !appStoreId(url) && !githubRepo(url)).map(hostOf)
  const bootstrap = hosts.some((host) => !isSharedHost(host)) ? await fetchJson(RDAP_BOOTSTRAP_URL) : undefined
  const lookups = new Map()
  for (const url of urls) {
    const host = hostOf(url)
    const storeId = appStoreId(url)
    const repo = githubRepo(url)
    if (storeId) lookups.set(`appstore:${storeId}`, () => appStoreRelease(storeId))
    else if (repo) lookups.set(`github:${repo.owner}/${repo.repo}`.toLowerCase(), () => repoCreation(github, repo))
    else if (!isSharedHost(host)) lookups.set(`domain:${host}`, () => domainRegistration(host, bootstrap))
  }
  const results = await Promise.all([...lookups.values()].map((lookup) => lookup()))
  return results.filter((result) => result && !Number.isNaN(result.date.getTime()))
}

// Links can point at an older site or repository than the product itself, so only the oldest one counts.
// A domain can also be newer than the product, so a registration date flags the issue without closing it.
async function findTooNew(github, sections, urls, now) {
  const cutoff = addMonths(now, -MIN_AGE_MONTHS)
  const declared = parseDeclaredDate(sections.get('first public release date'))
  if (declared && declared > cutoff) {
    return { firm: true, date: declared, claim: `You gave the first release date as ${formatDate(declared)}` }
  }
  const evidence = await independentEvidence(github, urls)
  const oldest = evidence.sort((a, b) => a.date - b.date)[0]
  return oldest && oldest.date > cutoff ? oldest : undefined
}

function findEarlier(issue, urls, allIssues) {
  const keys = new Set(urls.map(resourceKey))
  return allIssues.filter(
    (other) =>
      other.number < issue.number &&
      linkUrls(parseSections(other.body)).some((url) => keys.has(resourceKey(url)))
  )
}

function incompleteComment(missing) {
  return [
    'Thanks for the suggestion. This is an automated check.',
    `The [suggestion form](${FORM_URL}) needs every field filled in, and this one is missing: ${missing.join(', ')}.`,
    `The [criteria](${CRITERIA_URL}) set out what gets listed. I've closed this issue, so please open a new one with the form.`,
  ].join('\n\n')
}

function bypassComment() {
  return [
    'Thanks for opening this. This is an automated check.',
    `Issues on this repo need to come through one of the [issue forms](${ALL_FORMS_URL}), and this one didn't. The [suggestion form](${FORM_URL}) asks for the first release date, the pricing and your connection to the project.`,
    `The [criteria](${CRITERIA_URL}) set out what gets listed. I've closed this issue, so please open a new one with the right form.`,
  ].join('\n\n')
}

function tooNewComment(evidence) {
  const eligible = formatDate(addMonths(evidence.date, MIN_AGE_MONTHS))
  return [
    `Thanks for the suggestion. This is an automated check against the [criteria](${CRITERIA_URL}).`,
    `The list takes resources that have been public for at least six months. ${evidence.claim}, so I've closed this for now.`,
    `You're welcome to open a new suggestion after ${eligible} and link back to this one. If that date is wrong, comment here with a link showing the earlier release and the maintainer will take another look.`,
  ].join('\n\n')
}

function youngDomainComment(evidence) {
  return [
    `This is an automated check against the [criteria](${CRITERIA_URL}).`,
    `${evidence.claim}, which is less than six months ago. A domain can be newer than the product, so this stays open for the maintainer to check. If you have a link showing an earlier release, add it here.`,
  ].join('\n\n')
}

// Issues opened before the form existed are only checked for age and duplicates.
async function decide({ github, issue, allIssues, enforceForm, now }) {
  const sections = parseSections(issue.body)
  const kind = classify(issue, sections)
  const unstructured = kind === 'bypass' || kind === 'old-template'
  if (kind === 'ignore' || (kind === 'bypass' && !enforceForm)) return undefined
  if (unstructured && enforceForm) {
    return { labels: ['invalid'], comment: bypassComment(), close: 'not_planned', summary: 'closed, not sent through a form' }
  }

  const missing = kind === 'form' ? REQUIRED_SECTIONS.filter((name) => !sections.get(name.toLowerCase())) : []
  if (missing.length && enforceForm) {
    return { labels: ['invalid'], comment: incompleteComment(missing), close: 'not_planned', summary: `closed, form missing ${missing.join(', ')}` }
  }

  const urls = linkUrls(sections)
  const earlier = findEarlier(issue, urls, allIssues)
  const open = earlier.find((other) => other.state === 'open')
  if (open) {
    const comment = `This is the same resource as #${open.number}, which is still open, so I've closed this one as a duplicate. Add anything new over there.`
    return { labels: ['Suggestion'], comment, close: 'duplicate', summary: `closed, duplicate of #${open.number}` }
  }

  const tooNew = await findTooNew(github, sections, urls, now)
  if (tooNew?.firm) {
    return { labels: ['Suggestion', 'too-new'], comment: tooNewComment(tooNew), close: 'not_planned', summary: `closed, too new. ${tooNew.claim}` }
  }

  const notes = []
  if (tooNew) notes.push(youngDomainComment(tooNew))
  if (earlier.length) notes.push(`Earlier suggestions with the same link: ${earlier.map((other) => `#${other.number}`).join(', ')}.`)
  return {
    labels: tooNew ? ['Suggestion', 'too-new'] : ['Suggestion'],
    comment: notes.join('\n\n'),
    summary: tooNew ? `left open, flagged. ${tooNew.claim}` : 'left open for review',
  }
}

async function alreadyTriaged(github, target) {
  const { data } = await github.rest.issues.listComments({ ...target, per_page: 100 })
  return data.some((comment) => comment.user?.login === 'github-actions[bot]')
}

async function apply(github, target, decision) {
  await github.rest.issues.addLabels({ ...target, labels: decision.labels })
  if (decision.comment) await github.rest.issues.createComment({ ...target, body: decision.comment })
  if (decision.close) await github.rest.issues.update({ ...target, state: 'closed', state_reason: decision.close })
}

module.exports = async ({ github, context, core, now = new Date() }) => {
  const backfill = context.eventName === 'workflow_dispatch'
  const inputs = context.payload.inputs || {}
  const dryRun = backfill && String(inputs.dry_run) !== 'false'
  const wanted = (inputs.issues || '').match(/\d+/g)?.map(Number) || []

  const listed = await github.paginate(github.rest.issues.listForRepo, { ...context.repo, state: 'all', per_page: 100 })
  const allIssues = listed.filter((issue) => !issue.pull_request)
  const queue = backfill
    ? allIssues
        .filter((issue) => issue.state === 'open' && (!wanted.length || wanted.includes(issue.number)))
        .sort((a, b) => a.number - b.number)
    : [context.payload.issue]

  const rows = []
  for (const issue of queue) {
    const target = { ...context.repo, issue_number: issue.number }
    if (backfill && (await alreadyTriaged(github, target))) {
      rows.push([`#${issue.number}`, issue.title, 'skipped, already triaged'])
      continue
    }
    const decision = await decide({ github, issue, allIssues, enforceForm: !backfill, now })
    if (!decision) continue
    if (!dryRun) await apply(github, target, decision)
    if (decision.close) issue.state = 'closed'
    rows.push([`#${issue.number}`, issue.title, decision.summary])
  }

  for (const row of rows) core.info(row.join(' | '))
  if (backfill) {
    const header = [{ data: 'Issue', header: true }, { data: 'Title', header: true }, { data: dryRun ? 'Would be' : 'Outcome', header: true }]
    await core.summary.addHeading(dryRun ? 'Dry run, nothing changed' : 'Triage run').addTable([header, ...rows]).write()
  }
}
