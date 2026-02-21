import { renderMcpAddView } from "./toolViews/mcpAddViewRenderer";
import { renderMcpView } from "./toolViews/mcpViewRenderer";
import { renderPromptsView } from "./toolViews/promptsViewRenderer";
import {
  renderSkillsDiscoveryView,
  renderSkillsReposView,
  renderSkillsView,
} from "./toolViews/skillsViewRenderer";

export function renderToolViews(props) {
  const { activeToolView } = props;

  if (activeToolView === "dashboard") {
    return null;
  }

  if (activeToolView === "skills") {
    return renderSkillsView(props);
  }
  if (activeToolView === "skillsDiscovery") {
    return renderSkillsDiscoveryView(props);
  }
  if (activeToolView === "skillsRepos") {
    return renderSkillsReposView(props);
  }
  if (activeToolView === "mcp") {
    return renderMcpView(props);
  }
  if (activeToolView === "mcpAdd") {
    return renderMcpAddView(props);
  }
  return renderPromptsView(props);
}
