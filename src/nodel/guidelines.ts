export const RECIPE_GUIDELINES = `# Nodel Recipe Guidelines

## Operating flow
- Before proposing recipe code, read the current recipe with nodel.read_recipe and read the live runtime toolkit with nodel.read_toolkit.
- For complex writes, first call nodel.get_workflow_guidance for the task and nodel.get_write_status to confirm which write tools and approval steps are available in the current sidecar configuration.
- Use nodel.get_node_console and nodel.get_node_activity before diagnosing runtime behavior.
- Use nodel.get_node_actions, nodel.get_node_signals, nodel.get_node_parameters, and nodel.get_node_bindings when metadata, bindings, or action/event names may be involved.
- Prefer a minimal patch that preserves the existing recipe style and behavior.
- Any apply step must use the current file hash from nodel.read_recipe, nodel.get_node_files, or the matching proposal tool.
- Use recipe script tools only for script.py: nodel.propose_recipe_script, nodel.propose_recipe_script_edit, nodel.save_recipe_script, and nodel.apply_recipe_script_edit.
- Use supporting-file tools for HTML, CSS, JavaScript, images, JSON, and other assets: nodel.propose_node_file_text/base64/edit, nodel.save_node_file_text/base64, and nodel.apply_node_file_edit. These tools must not be used for script.py.
- When using the MCP sidecar, keep the whole workflow in MCP: read/propose, request explicit operator approval, apply with the approval id, then verify through MCP reads.
- Before asking for approval or applying a dry-run/proposal, use nodel.verify_write_plan to check operation names, approval readiness, recipe verification, removePaths shape, and full-replace warnings. If write approvals are required, prefer nodel.request_write_approval where the MCP client supports elicitation, or use nodel.approve_write as the manual fallback. If write approvals are disabled by configuration, do not invent an approval step.
- Do not restart reflexively after supporting-file writes; they use REST/files/save and do not reload the node. Nodel normally reloads/restarts the node only after a script.py recipe save; use nodel.restart_node only when auto-reload is stuck, the console shows stale runtime state, or the operator explicitly requests a restart. Restart still requires separate explicit approval.
- Check nodel.health or /healthz before assuming writes are available. If writes are disabled, use proposal tools only and do not fall back to direct Nodel writes.
- Use nodel.verify_node_ready after recipe script writes, manual waits, or ambiguous reloads to summarize action/signal/binding probes and current-runtime console error heuristics. Supporting-file writes should normally be verified by read-back hash/content only.
- Review nodel.verify_recipe_script or the recipeVerification field returned by script proposal tools before applying script.py changes. Script write tools block Python recipes that fail the Python 2.5/Jython 2.5 compatibility check; supporting-file writes do not run recipe validation.
- Treat recipeVerification warnings as deliberate review items. Discouraged and unknown imports are allowed by default but should be justified by the target runtime and existing recipe patterns.
- Treat MCP tool errors as first-class results. Inspect isError/error payloads and always read back hashes after write tools instead of assuming an apply succeeded.

## Toolkit priority
- Treat /REST/Toolkit as the authoritative runtime contract for available recipe helpers.
- Prefer toolkit-provided functions and classes before Python standard library, Java classes, or external libraries.
- Use Nodel helpers such as Timer, TCP, UDP, SSH, get_url, quick_process, json_encode, json_decode, console, date_now/date_parse/date_at/date_instant, lookup_* helpers, create_* helpers, and binding/action/event decorators when the toolkit provides them.
- Only use non-toolkit alternatives when the toolkit does not provide the needed capability, and explain that choice in the patch rationale.
- Do not import broad Python, Java, networking, process, JSON, threading, or async libraries when a toolkit helper exists.

## Runtime compatibility
- Treat recipes as Jython/Python 2.x compatible unless the target runtime is explicitly confirmed otherwise.
- Avoid Python 3-only syntax: f-strings, async/await, type annotations, keyword-only arguments, pathlib-only patterns, dataclasses, dict unpacking, walrus operator, match/case, and Python 3 stdlib assumptions.
- In Python 2.5, only use with statements when the recipe imports from __future__ import with_statement.
- Use percent string formatting instead of f-strings.
- Use Python 2 exception syntax where an exception object is needed, for example: except ValueError, e:
- Keep imports minimal. Imports should be justified by the live toolkit, an existing recipe pattern, or a clear runtime need.
- Avoid process, thread, event-loop, raw socket, raw HTTP, and blocking sleep APIs. The MCP verifier blocks known hazardous imports/calls and warns on discouraged imports; prefer Nodel toolkit helpers such as Timer, TCP, UDP, SSH, get_url, quick_process, request_queue, and Process where supported by the runtime.

## Runtime lifecycle
- Nodel injects toolkit globals into the Jython recipe environment, effectively making nodetoolkit helpers and console available without broad imports.
- Normal startup executes recipe files, extracts declarations, binds parameters/actions/events, replaces declaration globals with configured values or live Java-backed point objects, runs @before_main functions, runs main() if present, runs @after_main functions, then enables managed timers, sockets, SSH sessions, and processes.
- On restart or shutdown, Nodel runs @at_cleanup functions and closes managed resources.
- Declare fixed bindings at module scope, but do not perform real I/O or fragile setup at import time. A top-level exception can prevent binding extraction.

## Initialization order
- Parameter definitions, event/action definitions, imports, constants, function definitions, and placeholder global variables may be declared at module scope.
- Do not compute values from Parameters at module load time.
- Managed helpers such as Timer, TCP, UDP, SSH, and Process may be declared at module scope when their identity and callbacks are static.
- Configure Timer intervals, delays, enabled state, destinations, ports, credentials, URLs, and other parameter-dependent settings inside main() or @after_main.
- Use @after_main for final parameter-dependent managed-resource setup because managed resources are enabled after @after_main runs.
- Create dynamic remote event/action bindings inside main() or another setup function, especially when their count or names depend on Parameters.
- Prefer declarative LocalEvent definitions for fixed local state outputs. Use create_local_event or Signal only when names/counts are dynamic or the existing recipe pattern requires it.
- Use global declarations when modifying module-level state inside functions.

## Callbacks and lifecycle hooks
- Nodel catches and logs exceptions from most managed callbacks, including timers, TCP/UDP/SSH/process callbacks, dynamic action callbacks, remote event callbacks, and delayed calls. Do not wrap every callback defensively by default.
- Use try/except when failure is expected and should become a warning or local event, when calling synchronous external I/O such as get_url or blocking request/wait calls, and around optional setup in main(), @before_main, or @after_main when the recipe should continue.
- Avoid throwing from main() or lifecycle hooks unless startup should fail. Optional setup should log a clear warning or emit an error/status event instead.
- Prefer call() for delayed asynchronous work and call_safe() when mutating shared recipe state through Nodel's callback queue.

## Parameters and state
- Parameters are for operator configuration, not every variable.
- Use Parameters for values that operators should configure or persist.
- Read Parameter values inside main(), handlers, or evaluation functions rather than caching them at module load time.
- Parameter declaration globals become configured values after binding, or None when unset. Use explicit fallbacks for defaults instead of relying on declaration metadata as runtime values.
- Use module-level state for internal runtime state such as connection status, buffers, queues, retry counters, cached values, and timers.
- Prefer underscore-prefixed names for module-level mutable state.
- Prefer uppercase names for constants.
- Validate required Parameters in main() or before use. Use toolkit helpers such as is_blank when available.
- Use JSON-compatible values for action arguments, event arguments, parameters, and metadata: None, booleans, numbers, strings, lists/tuples, and dictionaries with string keys.
- Avoid passing arbitrary Python or Java objects across Nodel actions/events because they may not serialize cleanly.

## Actions, events, signals, and bindings
- Keep action and signal/event names consistent between code, metadata, bindings, and documentation.
- Use standard declaration names so Nodel can discover fixed points: param_Name, local_event_Name, local_action_Name, remote_action_Name, and remote_event_Name.
- After binding, declaration globals are replaced by configured values or live Java-backed objects such as local events and remote actions.
- Inputs from other nodes should be remote event handlers or remote bindings, not LocalEvent state placeholders.
- Inputs from local operators or UI should be local actions or Parameters, depending on whether they are commands or configuration.
- State outputs should be LocalEvent values with schemas. Use emitIfDifferent when duplicate state emissions should be suppressed.
- Outputs that command other nodes should use RemoteAction bindings or toolkit remote action helpers, not Parameter strings, unless the user explicitly requests text-based selection.
- Include useful title, desc/description, group, caution, order, and schema metadata where the local recipe style supports it. Schemas should be JSON-schema-like dictionaries.
- Use create_* helpers or decorators for dynamic points only when names/counts are dynamic or the existing recipe style requires it.
- emitIfDifferent uses Nodel's same_value comparison semantics for suppressing duplicate state emissions.
- Check remote_action_Name.isUnbound() before calling remote actions when an unbound binding is plausible.
- Use getBindingState() for remote event/action binding state; avoid deprecated getStatus().
- Use lookup_* helpers only after binding has occurred, normally in main(), @after_main, handlers, or timers.
- Prefer one-argument handlers for dynamically created local actions for compatibility.
- After changing action/event/binding definitions, verify nodel.get_node_bindings and nodel.get_node_signals, not just file hashes. A recipe can save successfully but still fail to register bindings at reload.
- If console logs show "Already bound" or duplicate registration errors after a file write, first check whether fixed local outputs should be declarative LocalEvent definitions and whether dynamic bindings are being created before main().

## Custom UI and static assets
- Nodel treats the recipe content/ folder specially for custom UI/static assets.
- Place UI files and assets such as legacy v1 XML dashboards, HTML, CSS, JavaScript, images, fonts, source maps, and WebAssembly under content/ unless the operator explicitly intends another path.
- The content/ folder is served as the node's web root. Store a file as content/css/custom.css, but reference it from HTML as css/custom.css or /nodes/<NodeName>/css/custom.css; do not include content/ in browser-facing URLs.
- Before creating or editing a legacy v1 XML/XSLT dashboard such as content/index.xml, call nodel.get_ui_guidelines for the XML construction, action/event/join, and verification contract.
- Use nodel.get_ui_component_reference for exact generated DOM, class propagation, built-in CSS defaults, and focused CSS recipes instead of inspecting templates.xsl/theme.less manually.
- Validate proposed XML with nodel.verify_ui_file(content=...) before writing and validate the saved file after read-back. The validator checks XML, attributes, points, schemas, generated mute companions, and assets, but it does not render the page in a browser.
- Use nodel.save_node_file_text for text files and nodel.save_node_file_base64 for binary assets when writing through MCP.
- The MCP sidecar warns, but does not block, when UI/static asset paths are outside content/.

## Device I/O
- Use TCP, UDP, SSH, get_url, quick_process, request_queue, or other toolkit helpers before lower-level alternatives.
- For external commands, prefer quick_process with a finished callback, timeout, explicit command list, and defensive stdout/stderr handling.
- quick_process finished callbacks may receive None on timeout; handle that path explicitly.
- For JSON, use json_encode and json_decode instead of importing json or org.json.
- For HTTP, use get_url instead of requests, urllib, urllib2, or httplib. With fullResponse=False, non-2xx responses raise an exception; use try/except for expected HTTP failures or fullResponse=True when status/header inspection is needed.
- For TCP/UDP/SSH, log connect/disconnect/timeout paths and parse responses defensively.
- For TCP/SSH, send() queues safely behind request/response operations while sendNow() writes immediately if connected.
- Timers and get_url wrapper timeouts use seconds. TCP/SSH/Process/request_queue request timeout setters use milliseconds.
- Avoid blocking wait calls such as requestWaitAndReceive and waitAndReceive in callbacks unless there is a clear need and timeout handling.
- Use request_queue to coordinate asynchronous request/response APIs instead of sleeps, threads, or ad-hoc polling.
- Avoid threading and async libraries unless a local recipe already proves they are supported and necessary.

## Logging and diagnostics
- Use console.info, console.warn, console.error, or console.log. Do not use print.
- Log startup, configuration problems, connection changes, retries, parse failures, command failures, and recoverable errors.
- Keep logs concise and actionable. Include sanitized endpoints, command names, and short response snippets when useful.
- Do not log secrets, bearer tokens, passwords, API keys, or full credential-bearing URLs.
- Status and debug events are useful for full recipes, but small bug patches should not add broad monitoring scaffolding unless it helps the fix.

## Reliability and patch style
- Validate action arguments before sending commands to devices or other nodes.
- Add timeouts where toolkit APIs support them.
- Parse device and process responses defensively.
- Emit clear state/status values and avoid silent failures.
- Preserve existing public action/event/parameter names unless the user explicitly approves a breaking change.
- Keep recipe patches narrow. Avoid unrelated rewrites, formatting churn, or replacing established local patterns.

## Deprecated helpers
- Avoid deprecated helper names in new recipes: call_delayed, getURL, releaseNode, Event, and Action.
- Prefer call, get_url, release_node, create_local_event or Signal, and create_local_action or @local_action.

## Using examples
- Public recipes at https://github.com/museumsvictoria/nodel-recipes are useful guidance, but may include older conventions.
- Existing local recipe code and the live /REST/Toolkit should take precedence over sampled prompt rules when they disagree.
- When generating a complete new recipe, include enough structure, metadata, logging, and status visibility for production use. When patching an existing recipe, prefer the smallest clear change.
`;
