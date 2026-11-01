// lib/scrub.mjs — redact secrets from text bound for GitHub (the workstreams
// repo). Token-shaped strings by pattern, secret-named assignments (.env, YAML,
// JSON, shell), and any line quoted from a Vault file. Returns what it took out,
// masked, so the wrap-up preview can show it without showing the secret.

// Order matters: whole blocks and specific prefixes before the generic assignment rule.
const RULES = [
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['api-key', /\bsk-(?:ant-|proj-|svcacct-|or-)?[A-Za-z0-9_-]{20,}/g],
  ['aws-key-id', /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['google-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['bearer', /(?<=\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/g],
  ['url-password', /(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi],
  // KEY=value, key: value, "key": "value", export KEY="value", when the name says secret.
  ['secret-value', /(?<=(?:^|[\s,{"'`])(?:export\s+)?["']?[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]*["']?\s*[=:]\s*["']?)(?!\[redacted)[^\s"'`,}]{8,}/gim],
];

// Only a known, non-secret prefix is shown; otherwise just the length.
const PREFIX = /^(?:gh[pousr]_|github_pat_|sk-(?:ant-|proj-|svcacct-|or-)?|AKIA|ASIA|ABIA|ACCA|xox[abposr]-|AIza|eyJ|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)/;
const mask = (s) => `${PREFIX.exec(s)?.[0] || ''}…(${s.length})`;

/**
 * Redact secrets in `text`. `vault` is the content of Vault files: any of
 * their lines (12+ chars) found in the text is redacted too.
 * Returns { text, redactions: [{ kind, masked }] }.
 */
export function scrub(text, { vault = [] } = {}) {
  let out = String(text ?? '');
  const redactions = [];
  const lines = new Set();
  for (const v of vault) for (const l of String(v).split('\n')) { const t = l.trim(); if (t.length >= 12) lines.add(t); }
  // Longest first, so a line containing another is taken whole.
  for (const l of [...lines].sort((a, b) => b.length - a.length)) {
    if (!out.includes(l)) continue;
    out = out.split(l).join('[redacted:vault]');
    redactions.push({ kind: 'vault', masked: mask(l) });
  }
  for (const [kind, re] of RULES) {
    out = out.replace(re, (m) => { redactions.push({ kind, masked: mask(m) }); return `[redacted:${kind}]`; });
  }
  return { text: out, redactions };
}
