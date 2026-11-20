import { AGENT_CAPABILITIES, AGENT_SESSION_WORKFLOW_TOOLS, AGENT_SUBAGENT_WORKFLOW_TOOLS, type AgentSessionWorkflowBinding } from "@hosty-sdk/app/agent";
import { TASK_ORCHESTRATION_GUIDE } from "../tasks/tools.js";

export function workflowCapabilities(binding: AgentSessionWorkflowBinding): string[] {
  const tools = binding.tools ?? AGENT_SESSION_WORKFLOW_TOOLS;
  return [
    ...(AGENT_SESSION_WORKFLOW_TOOLS.some(name => tools.some(selected => selected === name)) ? [AGENT_CAPABILITIES.consumerWorkflow] : []),
    ...(AGENT_SUBAGENT_WORKFLOW_TOOLS.some(name => tools.some(selected => selected === name)) ? [AGENT_CAPABILITIES.sessionSubagents] : []),
  ];
}

export function workflowGuide(binding?: AgentSessionWorkflowBinding): string {
  if (!binding) return "";
  const capabilities = workflowCapabilities(binding);
  const guides = [];
  if (capabilities.includes(AGENT_CAPABILITIES.consumerWorkflow)) guides.push(TASK_ORCHESTRATION_GUIDE);
  if (capabilities.includes(AGENT_CAPABILITIES.sessionSubagents)) guides.push(
    "To delegate work from this chat to another Harness profile, read subagent_profiles and use subagent_spawn with the selected profile revision and an explicit assignment. Each child has its own chat and returns its final reply. Reuse the request ID for retries. Use subagent_status to inspect direct children. Register subagent_wait and end your turn when it reports a pending wait. Harness resumes this chat with the child outcomes. Review the result before assigning the next step. This workflow works in ordinary chats."
  );
  return guides.join("\n\n");
}
