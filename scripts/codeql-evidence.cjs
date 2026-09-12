/* Diagnostic metadata only: never print result messages, code snippets, fixes,
 * artifact contents, environment values or tokens from a SARIF report. */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

// SARIF 2.1.0 sections 3.27.7, 3.52 and 3.54: a result may refer to
// rules in an extension, not the driver. Index/GUID references are scoped;
// falling back across components can attach another rule's severity.
function resolveRule(run, result) {
  const reference = result.rule;
  const target = reference?.toolComponent;
  const indexed = (items, index) => Number.isInteger(index) && index >= 0 ? items?.[index] : undefined;
  let component = run.tool?.driver;
  if (target?.index !== undefined) {
    component = indexed(run.tool?.extensions, target.index);
  } else if (target?.guid !== undefined) {
    component = [run.tool?.driver, ...(run.tool?.extensions || [])]
      .find(entry => entry?.guid === target.guid);
  }
  if (target?.guid !== undefined && component?.guid !== target.guid) return undefined;
  const rules = component?.rules || [];
  const index = reference?.index ?? result.ruleIndex;
  let rule;
  if (index !== undefined) rule = indexed(rules, index);
  else if (reference?.guid !== undefined) rule = rules.find(entry => entry.guid === reference.guid);
  else rule = rules.find(entry => entry.id === (reference?.id ?? result.ruleId));
  if (reference?.guid !== undefined && rule?.guid !== reference.guid) return undefined;
  return rule;
}

function summarizeSarif(report) {
  assert.ok(Array.isArray(report?.runs), 'CodeQL SARIF runs are missing');
  const rows = [];
  for (const run of report.runs) {
    function location(entry) {
      const physical = entry?.physicalLocation;
      if (!physical) return null;
      const artifact = physical.artifactLocation;
      const uri = artifact?.uri ?? run.artifacts?.[artifact?.index]?.location?.uri;
      return {
        path: typeof uri === 'string' ? uri : null,
        line: physical.region?.startLine ?? null,
        endLine: physical.region?.endLine ?? null,
      };
    }
    for (const result of run.results || []) {
      const rule = resolveRule(run, result);
      rows.push({
        rule: result.ruleId ?? result.rule?.id ?? rule?.id ?? null,
        securitySeverity: rule?.properties?.['security-severity'] ?? null,
        level: result.level ?? rule?.defaultConfiguration?.level ?? null,
        locations: (result.locations || []).map(location).filter(Boolean),
        flows: (result.codeFlows || []).flatMap(flow => (flow.threadFlows || [])
          .map(thread => (thread.locations || []).map(entry => location(entry.location)).filter(Boolean))),
      });
    }
  }
  return rows;
}
module.exports = { summarizeSarif };
if (require.main === module) {
  const rows = summarizeSarif(JSON.parse(readFileSync('codeql-results/javascript.sarif', 'utf8')));
  console.log(JSON.stringify({ codeqlEvidence: 'metadata-only', findings: rows.length }));
  // JSON framing escapes line breaks; report content cannot become a workflow
  // command. This diagnostic does not dismiss findings or replace either gate.
  for (const row of rows) console.log(JSON.stringify(row));
}
