import { jsx, jsxs } from "react/jsx-runtime";
import { ArrowLeft } from "lucide-react";

export function renderPromptsView(props) {
  const { setActiveToolView } = props;

  return /* @__PURE__ */ jsxs("main", { className: "tools-pane-wrap", children: [
    /* @__PURE__ */ jsx("section", { className: "tools-view-header", children: /* @__PURE__ */ jsxs("div", { className: "tools-view-left", children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          className: "skills-back-btn",
          onClick: () => setActiveToolView("dashboard"),
          title: "返回账号列表",
          "aria-label": "返回账号列表",
          children: /* @__PURE__ */ jsx(ArrowLeft, { className: "skills-back-icon" })
        }
      ),
      /* @__PURE__ */ jsx("h1", { className: "skills-inline-title", children: "Prompts 面板" })
    ] }) }),
    /* @__PURE__ */ jsxs("section", { className: "tools-placeholder-panel", children: [
      /* @__PURE__ */ jsx("h2", { children: "Prompts" }),
      /* @__PURE__ */ jsx("p", { children: "按钮已接入为 CC Switch 同款三按钮结构。Prompts 内容后续可继续扩展。" })
    ] })
  ] });
}
