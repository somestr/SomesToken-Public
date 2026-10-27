#!/usr/bin/env node
import { assessEfficiencyPilot, beginEfficiencyPilotEpoch } from '../lib/optimization/pilot.mjs';
import { activePolicyStatus, policySelector, selectActivePolicy,activeTaskPolicy } from '../lib/optimization/active-policy.mjs';
import {recordLifecycleEvent,lifecycleCheck,recordLifecycleSkills,readSkillEvidence} from '../lib/optimization/lifecycle-checks.mjs';
import {workspaceDirectory,readWorkspaceFile} from '../lib/workspace-usage.mjs';
import {configuredCodexLedgerRoot} from '../lib/codex-ledger.mjs';
import {configuredClaudeWorkspaceRoot} from '../lib/claude-workspace.mjs';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { mutateOptimizationState,pluginDataRoot } from '../lib/runtime.mjs';
import { upsertGate } from '../lib/optimization/gates.mjs';
import { pilotReadiness, startExperiment, beginExperimentWork, closeExperiment, cancelExperiment, listExperiments, experimentStatus } from '../lib/optimization/experiments.mjs';
import { POLICY_ENUMS, SUPPORTED_COMPARISON_AXES, normalizeExperimentRun } from '../lib/optimization/schema.mjs';
import { recordCalibrationFeedback } from '../lib/optimization/calibration.mjs';
import { optimizationReport } from '../lib/reporting.mjs';
import {humanLabel} from '../lib/core.mjs';
import { readSomesTokenState } from '../lib/report-adapter.mjs';

function value(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const candidate = args[index + 1];
  return candidate && !candidate.startsWith('--') ? candidate : undefined;
}

function has(args, name) { return args.includes(name); }

function output(result, json) {
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (result?.ok === false) process.stdout.write(`SomesToken optimization · unavailable · ${humanLabel(result.error??result.status)} · Next: use --help for supported commands.\n`);
  else process.stdout.write(`SomesToken optimization · ${humanLabel(result?.status ?? 'updated')}\n`);
}

const POLICY_OPTIONS = {
  policy_context_version: '--policy-context-version', subagent_limit: '--subagent-limit', fanout_limit: '--fanout-limit',
  retry_policy: '--retry-policy', cache_strategy: '--cache-strategy', session_strategy: '--session-strategy',
  manual_gate_handling: '--manual-gate-handling', context_policy: '--context-policy',
  ponytail_mode: '--ponytail-mode', efficiency_policy_version: '--efficiency-policy-version',
};
const NUMERIC_POLICY_FIELDS = new Set(['policy_context_version', 'efficiency_policy_version', 'subagent_limit', 'fanout_limit']);
const FROZEN_OPTIONS = ['--task-key', '--root-key', '--work-unit', '--acceptance-fingerprint', '--workload-subtype',
  '--variant', '--workload', '--axis', '--recommendation', '--model', '--effort', '--source-type', '--schema-version',
  '--usage-schema-version', '--adapter-version', '--agent-policy', '--router-state', '--router-version',
  '--pricing-profile', '--service-tier', ...Object.values(POLICY_OPTIONS)];
const VALUE_OPTIONS = new Set([...FROZEN_OPTIONS, '--id', '--host', '--status', '--source', '--revision', '--replace', '--outcome',
  '--verification', '--tokens', '--coverage', '--main-tokens', '--subagent-tokens', '--rework-count', '--receipts',
  '--quality', '--provider-usage', '--input-tokens', '--cached-input-tokens', '--output-tokens',
  '--reasoning-output-tokens', '--cache-write-input-tokens', '--retry-rate', '--fanout', '--decision', '--feedback']);
const POLICY_VALUE_OPTIONS = new Set(['--scope','--task-id','--mode','--development']);
const LIFECYCLE_VALUE_OPTIONS = new Set(['--task-id','--stage','--generation','--evidence']);

const CLOSE_NUMERIC_OPTIONS = {
  total_tokens:'--tokens',main_tokens:'--main-tokens',subagent_tokens:'--subagent-tokens',rework_count:'--rework-count',
  input_tokens:'--input-tokens',cached_input_tokens:'--cached-input-tokens',output_tokens:'--output-tokens',
  reasoning_output_tokens:'--reasoning-output-tokens',cache_write_input_tokens:'--cache-write-input-tokens',
  calculated_provider_usage:'--provider-usage',retry_rate:'--retry-rate',fanout:'--fanout',
};
function closeObservation(args) {
  return {
    experiment_id:value(args,'--id'),host:value(args,'--host'),outcome:value(args,'--outcome'),verification:value(args,'--verification'),
    coverage_status:value(args,'--coverage')??'unavailable',token_quality:value(args,'--quality')??'unavailable',
    receipt_ids:value(args,'--receipts')===undefined?undefined:value(args,'--receipts').split(','),
    ...Object.fromEntries(Object.entries(CLOSE_NUMERIC_OPTIONS).filter(([,flag])=>has(args,flag))
      .map(([field,flag])=>[field,Number(value(args,flag))])),
  };
}

function validateOptions(args,allowPolicyOptions=false,allowLifecycleOptions=false) {
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!option.startsWith('--')) continue;
    if (seen.has(option)) return { ok: false, error: 'duplicate_option', option };
    seen.add(option);
    if (option === '--json') continue;
    if (!VALUE_OPTIONS.has(option) && !(allowPolicyOptions&&POLICY_VALUE_OPTIONS.has(option))
      &&!(allowLifecycleOptions&&LIFECYCLE_VALUE_OPTIONS.has(option))) return { ok: false, error: 'invalid_option' };
    if (!args[index + 1] || args[index + 1].startsWith('--')) return { ok: false, error: 'missing_option_value', option };
    index += 1;
  }
  return null;
}

function parsePolicy(args) {
  return Object.fromEntries(Object.entries(POLICY_OPTIONS).map(([field, option]) => {
    const supplied = value(args, option);
    return [field, supplied === undefined ? undefined : NUMERIC_POLICY_FIELDS.has(field) ? Number(supplied) : supplied];
  }));
}

function parseStart(args) {
  return {
    ...parsePolicy(args),
    task_key: value(args,'--task-key'), root_key: value(args,'--root-key'),
    work_unit_id: value(args,'--work-unit'), acceptance_fingerprint: value(args,'--acceptance-fingerprint'),
    workload_subtype: value(args,'--workload-subtype'),
    evidence_basis: 'manual_recorded',
    experiment_id: value(args, '--id'),
    host: value(args, '--host') ?? (process.env.SOMESTOKEN_RUNTIME === 'claude' ? 'claude' : 'codex'),
    variant: value(args, '--variant'),
    workload_class: value(args, '--workload') ?? 'unknown',
    comparison_axis: value(args, '--axis'),
    recommendation_id: value(args, '--recommendation'),
    model: value(args, '--model'),
    effort: value(args, '--effort'),
    source_type: value(args, '--source-type') ?? 'main',
    schema_version: value(args, '--schema-version') ?? 'unknown',
    usage_schema_version: value(args, '--usage-schema-version') ?? 'unknown',
    adapter_version: value(args, '--adapter-version') ?? 'unknown',
    agent_policy: value(args, '--agent-policy') ?? 'unknown',
    router_state: value(args, '--router-state') ?? 'unknown',
    router_version: value(args, '--router-version') ?? 'unknown',
    pricing_profile: value(args, '--pricing-profile') ?? 'unknown',
    service_tier: value(args, '--service-tier') ?? 'unavailable',
  };
}

async function main(argv) {
  const args = argv.slice();
  if(args[0]==='output'&&args[1]==='guard')return (await import('../lib/optimization/output-guard.mjs')).runOutputGuardCommand(args.slice(2));
  if(args[0]==='output')return (await import('../lib/optimization/output-command.mjs')).runOutputCommand(args.slice(1));
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write([
      'SomesToken optimization · commands=policy,lifecycle,output,gate,experiment,calibration · option=--json',
      'policy set|status --host codex|claude --scope task|project|repository|host [--task-id ID] [--mode balanced|observe] [--development required|off] --json',
      'lifecycle status|check|begin --host codex|claude --task-id ID --json',
      'lifecycle skills --host codex|claude --task-id ID --stage selected|applied --generation N --evidence FILE --json',
      'lifecycle check exits 2 when tracking or required skill evidence is missing. Evidence is file-backed self-attestation, not proof of effectiveness.',
      'balanced emits bounded guidance; selection and emission do not prove application or savings. observe disables optimization guidance, not collection.',
      'Node tests: node --test --test-reporter="$PLUGIN_ROOT/lib/optimization/node-test-compact-reporter.mjs" <test-files>',
      'output summarize --format junit-xml|go-test-json|trx-xml|node-test-events-v1 --input FILE --exit-code N [--max-bytes N]',
      'output read --input FILE --id RECEIPT [--offset N] [--bytes N]; output report --json',
      'output guard enable|disable|status --host codex|claude [--kind tests|reads]: opt-in note after a large node --test, pytest or go test result (tests, the default) or a large shell file read or search (reads); each kind off by default, numeric counters only; SOMESTOKEN_READ_GUARD=on|off overrides reads for one process without writing state',
      'Output identity: --host codex|claude [--task-id ID] [--run-id ID] [--model MODEL] [--effort EFFORT] [--source-type main|subagent]',
      'Output limits, offsets and sizes are bytes; exit codes are process status codes. Model and effort options record identity only and never run or switch a model.',
      'Prepared payload bytes only; tracked detail reads count against reductions. No token or account-quota savings claim.',
      `experiment start: --axis ${SUPPORTED_COMPARISON_AXES.join('|')}`,
      'experiment pilot-begin --host codex|claude [--replace true] --json starts an explicit prospective measurement epoch without running work.',
      'Record all policy controls explicitly at start for eligible comparisons:',
      '  --policy-context-version 2 --efficiency-policy-version 0..1000000 --subagent-limit 0..64 --fanout-limit 0..64',
      'Efficiency policy version and Ponytail mode are declared experiment controls, not host activation proof; version 0 means observe with guidance disabled.',
      ...Object.entries(POLICY_ENUMS).map(([field, values]) => `  ${POLICY_OPTIONS[field]} ${values.join('|')}`),
      'Also record --model, --effort, --agent-policy, --source-type, --router-state enabled|disabled, --router-version (none when disabled),',
      '--schema-version, --usage-schema-version, --adapter-version, --pricing-profile and --service-tier before work.',
      'experiment close: --cached-input-tokens N --retry-rate N --fanout N record observed results; start settings are frozen.',
      'Incomplete legacy context remains unmeasured. Observed results do not stand in for policy settings.',
    ].join('\n') + '\n');
    return;
  }
  const json = has(args, '--json');
  const command = args.find((entry) => !entry.startsWith('--'));
  const invalidOptions = validateOptions(args,command==='policy',command==='lifecycle');
  if (invalidOptions) { output(invalidOptions, json); if(command==='lifecycle')process.exitCode=2; return; }
  if (command === 'policy') {
    const action=args[1], allowed=new Set(['--host','--scope','--task-id',...(action==='set'?['--mode','--development']:[])]);
    let valid=['set','status'].includes(action);
    for(let index=2;index<args.length;index+=1){
      if(args[index]==='--json')continue;
      if(!allowed.has(args[index])){valid=false;break;}
      index+=1;
    }
    const selector=policySelector({host:value(args,'--host'),scope:value(args,'--scope'),task_id:value(args,'--task-id'),cwd:process.cwd()});
    const development=value(args,'--development');
    if(development!==undefined&&!['required','off'].includes(development))valid=false;
    if(!valid||!selector||(has(args,'--task-id')&&selector.scope!=='task')){output({ok:false,error:'invalid_policy_options'},json);return;}
    const result=action==='set'?await mutateOptimizationState(process.env,async optimization=>{
      return selectActivePolicy(optimization.active_policies,selector,value(args,'--mode'),Date.now(),{developmentRequired:development===undefined?undefined:development==='required'});
    }):activePolicyStatus(readSomesTokenState(process.env).state?.optimization?.active_policies,selector);
    output(result,json);return;
  }
  if(command==='lifecycle'){
    const action=args[1],allowed=new Set(['--host','--task-id',...(action==='skills'?['--stage','--generation','--evidence']:[])]);
    const identity={host:value(args,'--host'),session_id:value(args,'--task-id')};
    let valid=['status','check','begin','skills'].includes(action)
      &&policySelector({host:identity.host,scope:'task',task_id:identity.session_id});
    for(let i=2;i<args.length;i++){if(args[i]==='--json')continue;if(!allowed.has(args[i])){valid=false;break;}i++;}
    if(!valid){output({ok:false,error:'invalid_lifecycle_options'},json);process.exitCode=2;return;}
    const observed=readSomesTokenState(process.env,{expectedHost:identity.host});
    if(!pluginDataRoot(process.env)||(action==='status'&&observed.source!=='plugin_data')){
      output({ok:false,status:observed.data_access==='plugin_data_unreadable'?'plugin_data_unreadable':'host_plugin_data_unavailable',
        required_environment:identity.host==='claude'?'CLAUDE_PLUGIN_DATA':'PLUGIN_DATA',ready_for_completion:false},json);
      process.exitCode=2;return;
    }
    const proof=action==='skills'?readSkillEvidence(value(args,'--evidence'),value(args,'--stage')):null;
    if(proof&&!proof.ok){output(proof,json);process.exitCode=2;return;}
    const refresh=optimization=>{
      const enabled=Boolean(identity.host==='codex'?configuredCodexLedgerRoot(process.env,process.env.PLUGIN_ROOT):configuredClaudeWorkspaceRoot(process.env));
      const selection=activeTaskPolicy(optimization.active_policies,{...identity,cwd:process.cwd()});
      recordLifecycleEvent(optimization.lifecycle_checks,{...identity,event:action==='begin'?'SessionStart':'Check',
        developmentRequired:selection?.development_required===true||lifecycleCheck(optimization.lifecycle_checks,identity).development_required===true,
        enabled,monitor:readWorkspaceFile(workspaceDirectory(process.env),'monitor.json')});
      return lifecycleCheck(optimization.lifecycle_checks,identity);
    };
    // Status refreshes the in-memory view only; no generation or state writes.
    const result=action==='status'?refresh(observed.state?.optimization??{}):
      await mutateOptimizationState(process.env,async optimization=>{
        if(action==='skills')return recordLifecycleSkills(optimization.lifecycle_checks,{...identity,...proof.proof,
          stage:value(args,'--stage'),generation:Number(value(args,'--generation'))});
        return refresh(optimization);
      });
    output(result,json);
    if(!result.ok||action==='check'&&!result.ready_for_completion)process.exitCode=2;
    return;
  }
  if (command === 'gate') {
    const result = await mutateOptimizationState(process.env, async (optimization) => {
      const previous = optimization.manual_gates?.[`${value(args, '--host')}:${value(args, '--id')}`];
      const next = upsertGate(optimization.manual_gates, {
        gate_id: value(args, '--id'),
        host: value(args, '--host'),
        status: value(args, '--status'),
        source: value(args, '--source') ?? 'cli',
        evidence_revision: value(args, '--revision') === undefined ? undefined : Number(value(args, '--revision')),
      });
      if (next.ok && next.changed && next.gate.status === 'open' && previous?.status !== 'open') optimization.counters.manual_gates_opened = Math.min(1_000_000, (optimization.counters.manual_gates_opened ?? 0) + 1);
      if (next.ok && next.changed && next.gate.status === 'satisfied' && previous?.status !== 'satisfied') optimization.counters.manual_gates_satisfied = Math.min(1_000_000, (optimization.counters.manual_gates_satisfied ?? 0) + 1);
      return next;
    });
    output(result, json);
    return;
  }
  if (command === 'experiment') {
    const action = args[args.indexOf('experiment') + 1];
    let result;
    if (has(args, '--replace') && action !== 'pilot-begin') { output({ ok: false, error: 'invalid_option' }, json); return; }
    if (action === 'pilot-begin') {
      const allowed = new Set(['--host', '--replace']);
      let valid = value(args, '--host') === 'codex' || value(args, '--host') === 'claude';
      for (let index = 2; index < args.length; index += 1) {
        if (args[index] === '--json') continue;
        if (!allowed.has(args[index])) { valid = false; break; }
        index += 1;
      }
      const replacement = value(args, '--replace');
      if (replacement !== undefined && replacement !== 'true') valid = false;
      if (!valid) { output({ ok: false, error: 'invalid_pilot_epoch_options' }, json); return; }
    }
    const observation = action === 'close' ? closeObservation(args) : null;
    if (action === 'close') {
      const invalidObservation = Object.entries(CLOSE_NUMERIC_OPTIONS).find(([field,option]) => {
        if (!has(args,option)) return false;
        const number = observation[field];
        return !Number.isFinite(number) || number < 0 || (!['--retry-rate','--provider-usage'].includes(option) && !Number.isSafeInteger(number));
      });
      if (invalidObservation) { output({ ok: false, error: 'invalid_observation', option: invalidObservation[1] }, json); return; }
      if (!normalizeExperimentRun({run_id:'close-observation',...observation}).token_components_consistent) {
        output({ok:false,error:'invalid_usage_components'},json);return;
      }
    }
    if (action === 'close' && FROZEN_OPTIONS.some(option => has(args, option))) {
      output({ ok: false, error: 'work_unit_conflict' }, json); return;
    }
    if (action === 'pilot-begin') result = await mutateOptimizationState(process.env, async (optimization) => {
      return beginEfficiencyPilotEpoch(optimization, { host: value(args, '--host'), replace: value(args, '--replace') === 'true' });
    });
    else if (action === 'start') result = await mutateOptimizationState(process.env, async (optimization) => {
      const start = parseStart(args);
      const epoch = optimization.experiment_pilot_epochs?.[start.host];
      const valueResult = startExperiment(optimization.experiments, { ...start, pilot_epoch: epoch?.epoch_id });
      if (valueResult.ok && valueResult.created === true) optimization.counters.experiments_started = Math.min(1_000_000, (optimization.counters.experiments_started ?? 0) + 1);
      return valueResult;
    });
    else if(action === 'begin') result = await mutateOptimizationState(process.env,async optimization=>beginExperimentWork(optimization.experiments,{id:value(args,'--id'),host:value(args,'--host')}));
    else if (action === 'close') result = await mutateOptimizationState(process.env, async (optimization) => {
      const closed = closeExperiment(optimization.experiments, observation);
      if (closed.ok) optimization.counters.experiments_closed = Math.min(1_000_000, (optimization.counters.experiments_closed ?? 0) + 1);
      if (closed.ok && (closed.run?.outcome === 'fail' || closed.run?.outcome === 'cancelled')) optimization.counters.outcome_regressions = Math.min(1_000_000, (optimization.counters.outcome_regressions ?? 0) + 1);
      return closed;
    });
    else if (action === 'cancel') result = await mutateOptimizationState(process.env, async (optimization) => {
      const cancelled = cancelExperiment(optimization.experiments, { experiment_id: value(args, '--id'), host: value(args, '--host') });
      if (cancelled.ok) optimization.counters.experiments_interrupted = Math.min(1_000_000, (optimization.counters.experiments_interrupted ?? 0) + 1);
      return cancelled;
    });
    else if (action === 'status') {
      const state = readSomesTokenState(process.env).state;
      result = experimentStatus(state?.optimization?.experiments, { experiment_id: value(args, '--id'), host: value(args, '--host') });
    } else if (action === 'list') {
      const state = readSomesTokenState(process.env).state;
      result = { ok: true, experiments: listExperiments(state?.optimization?.experiments, value(args, '--host')) };
    } else if(action === 'pilot'){
      const state=readSomesTokenState(process.env).state;
      const experiments=state?.optimization?.experiments;
      const host=value(args,'--host');
      const epoch=host?state?.optimization?.experiment_pilot_epochs?.[host]:undefined;
      result={...pilotReadiness(experiments,host),efficiency_pilot:assessEfficiencyPilot(experiments,{host,collection_evidence:epoch?.evidence??state?.optimization?.experiment_collection_evidence,pilot_epoch:epoch})};
    } else if (action === 'compare') {
      const state = readSomesTokenState(process.env).state;
      const report = optimizationReport(state);
      result = { ok: true, reduction_summary: report.reduction_summary, reductions: report.reductions, pairs: report.pairs, experiments: report.experiments };
    } else result = { ok: false, error: 'invalid_optimization_command' };
    output(result, json);
    return;
  }
  if (command === 'calibration') {
    const result = await mutateOptimizationState(process.env, async (optimization) => {
      const feedback = recordCalibrationFeedback(optimization.calibration, {
        feedback_id: value(args, '--id'),
        decision_id: value(args, '--decision'),
        feedback: value(args, '--feedback'),
        created_at: Date.now(),
      });
      if (feedback.ok && !feedback.duplicate) optimization.counters.calibration_feedback_seen = Math.min(1_000_000, (optimization.counters.calibration_feedback_seen ?? 0) + 1);
      return feedback;
    });
    output(result, json);
    return;
  }
  const state = readSomesTokenState(process.env).state;
  output({ ok: true, report: optimizationReport(state) }, true);
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(() => process.exitCode = 1);
