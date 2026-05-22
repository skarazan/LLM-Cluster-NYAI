'use strict';

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultPrompts() {
  return [
    {
      id: 'general-assistant',
      name: 'General Assistant',
      instruction: 'Be direct, helpful, and careful. Ask clarifying questions when the request is ambiguous.',
      enabled: true,
      skillIds: ['debugging'],
    },
    {
      id: 'code-reviewer',
      name: 'Code Reviewer',
      instruction: 'Focus on correctness, regressions, edge cases, and missing tests. Prioritize concrete findings.',
      enabled: true,
      skillIds: ['debugging', 'testing'],
    },
    {
      id: 'refactor-helper',
      name: 'Refactor Helper',
      instruction: 'Prefer small, safe refactors. Preserve behavior unless the user explicitly asks for a change.',
      enabled: true,
      skillIds: ['code-editing', 'testing'],
    },
  ];
}

function defaultSkills() {
  return [
    {
      id: 'debugging',
      name: 'Debugging',
      instruction: 'Investigate failures from the smallest reproducible anchor and validate changes with a focused check.',
      enabled: true,
    },
    {
      id: 'code-editing',
      name: 'Code Editing',
      instruction: 'Make the smallest possible edit that solves the problem at the root cause.',
      enabled: true,
    },
    {
      id: 'testing',
      name: 'Testing',
      instruction: 'Run or suggest the cheapest validation step after each meaningful code change.',
      enabled: true,
    },
  ];
}

function createDefaultPromptStudioState() {
  return {
    prompts: defaultPrompts(),
    skills: defaultSkills(),
    defaults: {
      chatPromptId: 'general-assistant',
      codePromptId: 'code-reviewer',
    },
  };
}

function normalizeItems(items, fallbackFactory) {
  const source = Array.isArray(items) ? items : [];
  if (!source.length) {
    return fallbackFactory();
  }

  return source
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => ({
      id: String(item.id || makeId(`item-${index}`)).trim(),
      name: String(item.name || `Item ${index + 1}`).trim(),
      instruction: String(item.instruction || '').trim(),
      enabled: item.enabled !== false,
    }));
}

function normalizeSkillIds(skillIds, validSkillIds, fallbackSkillIds) {
  if (!Array.isArray(skillIds)) {
    return fallbackSkillIds.slice();
  }

  const seen = new Set();
  return skillIds
    .map((skillId) => String(skillId || '').trim())
    .filter((skillId) => skillId && validSkillIds.has(skillId) && !seen.has(skillId) && seen.add(skillId));
}

function normalizePromptStudioState(state) {
  const base = createDefaultPromptStudioState();
  const merged = state && typeof state === 'object' ? state : {};
  const skills = normalizeItems(merged.skills, defaultSkills);
  const validSkillIds = new Set(skills.map((item) => item.id));
  const enabledSkillIds = skills.filter((item) => item.enabled !== false).map((item) => item.id);
  const promptSource = Array.isArray(merged.prompts) && merged.prompts.length ? merged.prompts : defaultPrompts();
  const prompts = promptSource
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => ({
      id: String(item.id || makeId(`prompt-${index}`)).trim(),
      name: String(item.name || `Prompt ${index + 1}`).trim(),
      instruction: String(item.instruction || '').trim(),
      enabled: item.enabled !== false,
      skillIds: normalizeSkillIds(
        item.skillIds,
        validSkillIds,
        enabledSkillIds.length ? enabledSkillIds : skills.map((skill) => skill.id)
      ),
    }));
  const defaults = merged.defaults && typeof merged.defaults === 'object' ? merged.defaults : {};
  const promptIds = new Set(prompts.map((item) => item.id));

  return {
    prompts,
    skills,
    defaults: {
      chatPromptId: promptIds.has(defaults.chatPromptId) ? defaults.chatPromptId : base.defaults.chatPromptId,
      codePromptId: promptIds.has(defaults.codePromptId) ? defaults.codePromptId : base.defaults.codePromptId,
    },
  };
}

function getPromptForMode(state, mode) {
  const normalized = normalizePromptStudioState(state);
  const promptId = mode === 'code' ? normalized.defaults.codePromptId : normalized.defaults.chatPromptId;
  const byId = normalized.prompts.find((prompt) => prompt.id === promptId && prompt.enabled !== false);
  if (byId) {
    return byId;
  }
  return normalized.prompts.find((prompt) => prompt.enabled !== false) || normalized.prompts[0] || null;
}

function buildSystemPrompt(state, mode) {
  const normalized = normalizePromptStudioState(state);
  const prompt = getPromptForMode(normalized, mode);
  const enabledSkills = normalized.skills.filter((skill) => skill.enabled !== false);
  const selectedSkillIds = prompt && Array.isArray(prompt.skillIds) ? prompt.skillIds : enabledSkills.map((skill) => skill.id);
  const selectedSkills = normalized.skills.filter((skill) => selectedSkillIds.includes(skill.id) && skill.enabled !== false);

  const sections = [
    `You are an AI agent operating in ${mode === 'code' ? 'code' : 'chat'} mode.`,
  ];

  if (prompt) {
    sections.push([
      `Default prompt preset: ${prompt.name}`,
      prompt.instruction || '(no instruction provided)',
    ].join('\n'));
  }

  if (selectedSkills.length) {
    sections.push([
      'Selected skills:',
      ...selectedSkills.map((skill) => `- ${skill.name}: ${skill.instruction || ''}`.trimEnd()),
    ].join('\n'));
  } else if (selectedSkillIds.length === 0) {
    sections.push('Selected skills: none');
  }

  sections.push(
    'Follow the selected prompt preset and skills closely.',
    'If a skill conflicts with the user request, explain the conflict briefly and choose the safest useful behavior.'
  );

  return sections.join('\n\n');
}

function getPromptPreviewSummary(state, mode) {
  const normalized = normalizePromptStudioState(state);
  const prompt = getPromptForMode(normalized, mode);
  const enabledSkills = normalized.skills.filter((skill) => skill.enabled !== false);
  const selectedSkillIds = prompt && Array.isArray(prompt.skillIds) ? prompt.skillIds : enabledSkills.map((skill) => skill.id);
  const selectedSkills = normalized.skills.filter((skill) => selectedSkillIds.includes(skill.id) && skill.enabled !== false);
  return {
    promptName: prompt ? prompt.name : 'None',
    skillCount: selectedSkills.length,
    skills: selectedSkills.map((skill) => skill.name),
  };
}

module.exports = {
  makeId,
  createDefaultPromptStudioState,
  normalizePromptStudioState,
  getPromptForMode,
  buildSystemPrompt,
  getPromptPreviewSummary,
};
