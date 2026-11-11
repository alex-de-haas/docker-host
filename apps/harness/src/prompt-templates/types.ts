export interface PromptTemplate {
  id: string;
  name: string;
  shortcut: string;
  text: string;
}

export interface PromptTemplateDirectory {
  revision: number;
  templates: PromptTemplate[];
}

export interface SavePromptTemplates extends PromptTemplateDirectory {
  requestId: string;
}
