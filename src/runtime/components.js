import { jsx, jsxs } from "react/jsx-runtime";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  formatCheckedAt,
  formatReset,
  pct,
  quotaClass,
  statusClass,
  stripCurrentActiveSuffix,
  supportBadgeClass,
  supportBadgeText,
} from "../utils";

export function SortableProfileCard({
  profile,
  index,
  selected,
  isModeActive,
  busy,
  showLiveQuerying = false,
  isQuotaRefreshing = false,
  liveQueryError = null,
  onSelect,
  onRefreshQuota,
  onApply,
  onSetAlias,
  onDelete,
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: profile.name,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    animationDelay: `${Math.min(index * 45, 320)}ms`,
  };
  const statusText = stripCurrentActiveSuffix(profile.status);
  const compactError = (raw) => {
    const text = (raw || "").trim();
    if (!text) {
      return null;
    }
    return text.length > 72 ? `${text.slice(0, 72)}...` : text;
  };
  const liveError = compactError(liveQueryError);
  return /* @__PURE__ */ jsx("div", { ref: setNodeRef, style, className: `sortable-item ${isDragging ? "sorting-item-dragging" : ""}`, children: /* @__PURE__ */ jsxs(
    "article",
    {
      className: `profile-card ${selected ? "selected" : ""} ${isModeActive ? "active" : ""} ${isDragging ? "dragging-source" : ""}`,
      onClick: () => onSelect(profile.name),
      children: [
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            className: "card-left-icon drag-handle",
            title: "拖拽调整顺序",
            "aria-label": `拖拽调整顺序: ${profile.displayWorkspace}`,
            onClick: (e) => e.stopPropagation(),
            ...attributes,
            ...listeners,
            children: "⋮⋮",
          }
        ),
        /* @__PURE__ */ jsxs("div", { className: "card-main", children: [
          /* @__PURE__ */ jsxs("div", { className: "workspace-title", children: [
            /* @__PURE__ */ jsxs("span", { className: "profile-no", children: ["#", index + 1] }),
            /* @__PURE__ */ jsx("span", { className: "workspace-name", children: profile.displayWorkspace }),
          ] }),
          /* @__PURE__ */ jsx("div", { className: "email-line", children: profile.email || "-" }),
          /* @__PURE__ */ jsxs("div", { className: "quota-line", children: [
            /* @__PURE__ */ jsxs("span", { className: `quota-pill quota-pill-week ${quotaClass(profile.oneWeekRemainingPercent)}`, children: [
              /* @__PURE__ */ jsx("strong", { children: "1 周" }),
              /* @__PURE__ */ jsx("b", { children: pct(profile.oneWeekRemainingPercent) }),
              /* @__PURE__ */ jsx("small", { children: formatReset(profile.oneWeekResetsAt) }),
            ] }),
            /* @__PURE__ */ jsxs("span", { className: `quota-pill quota-pill-hour ${quotaClass(profile.fiveHourRemainingPercent)}`, children: [
              /* @__PURE__ */ jsx("strong", { children: "5 小时" }),
              /* @__PURE__ */ jsx("b", { children: pct(profile.fiveHourRemainingPercent) }),
              /* @__PURE__ */ jsx("small", { children: formatReset(profile.fiveHourResetsAt, "time") }),
            ] }),
          ] }),
          /* @__PURE__ */ jsx("div", { className: "meta-line", children: isQuotaRefreshing ? /* @__PURE__ */ jsxs("span", { className: "meta-querying", children: [
            /* @__PURE__ */ jsx("span", { className: "meta-spinner", "aria-hidden": true }),
            /* @__PURE__ */ jsx("span", { children: "配额查询中..." }),
          ] }) : showLiveQuerying && liveError ? /* @__PURE__ */ jsxs("span", { className: "meta-error", title: liveQueryError || void 0, children: [
            "配额实时查询失败: ",
            liveError,
          ] }) : showLiveQuerying ? /* @__PURE__ */ jsxs("span", { className: "meta-querying", children: [
            /* @__PURE__ */ jsx("span", { className: "meta-spinner", "aria-hidden": true }),
            /* @__PURE__ */ jsx("span", { children: "配额实时查询中..." }),
          ] }) : `最近刷新: ${formatCheckedAt(profile.lastCheckedAt)}` }),
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "card-side", children: [
          /* @__PURE__ */ jsxs("div", { className: "support-badge-row", children: [
            isModeActive ? /* @__PURE__ */ jsx("span", { className: "mode-active-chip", children: "当前生效" }) : null,
            /* @__PURE__ */ jsx("span", { className: `support-badge ${supportBadgeClass(profile.support)}`, children: supportBadgeText(profile.support) }),
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "status-row", children: [
            /* @__PURE__ */ jsx("span", { className: `status-pill ${statusClass(statusText)}`, children: statusText }),
            /* @__PURE__ */ jsx(
              "button",
              {
                className: `mini-icon ${isQuotaRefreshing ? "mini-icon-querying" : ""}`,
                disabled: busy,
                title: isQuotaRefreshing ? "配额查询中..." : "刷新此账号额度",
                "aria-label": isQuotaRefreshing ? "配额查询中" : "刷新此账号额度",
                onClick: (e) => {
                  e.stopPropagation();
                  onRefreshQuota(profile.name);
                },
                children: /* @__PURE__ */ jsx("span", { className: isQuotaRefreshing ? "icon-spin" : void 0, "aria-hidden": true, children: "↻" }),
              }
            ),
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "action-rail", children: [
            /* @__PURE__ */ jsx(
              "button",
              {
                className: "card-action primary",
                disabled: busy || isModeActive,
                onClick: (e) => {
                  e.stopPropagation();
                  onApply(profile.name);
                },
                children: isModeActive ? "使用中" : "使用",
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                className: "card-action",
                disabled: busy,
                onClick: (e) => {
                  e.stopPropagation();
                  onSetAlias(profile.name);
                },
                children: "改名",
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                className: "card-action danger",
                disabled: busy,
                onClick: (e) => {
                  e.stopPropagation();
                  onDelete(profile.name);
                },
                children: "删除",
              }
            ),
          ] }),
        ] }),
      ],
    }
  ) });
}

export function McpIcon({ size = 16, className = "" }) {
  return /* @__PURE__ */ jsxs(
    "svg",
    {
      fill: "currentColor",
      fillRule: "evenodd",
      height: size,
      width: size,
      className,
      viewBox: "0 0 24 24",
      xmlns: "http://www.w3.org/2000/svg",
      "aria-hidden": true,
      children: [
        /* @__PURE__ */ jsx("path", { d: "M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z" }),
        /* @__PURE__ */ jsx("path", { d: "M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z" }),
      ],
    }
  );
}

export function SkillTargetSwitch({ label, icon, checked, busy, onClick }) {
  return /* @__PURE__ */ jsxs(
    "button",
    {
      type: "button",
      role: "switch",
      "aria-checked": checked,
      className: `skill-target-switch ${checked ? "on" : "off"}`,
      onClick,
      disabled: busy,
      children: [
        /* @__PURE__ */ jsxs("span", { className: "skill-target-label", children: [
          icon ? /* @__PURE__ */ jsx("img", { src: icon, alt: "", "aria-hidden": true, className: "skill-target-icon" }) : /* @__PURE__ */ jsx("span", { "aria-hidden": true, className: "skill-target-dot" }),
          /* @__PURE__ */ jsx("span", { children: label }),
        ] }),
        /* @__PURE__ */ jsx("span", { className: `skill-target-track ${checked ? "on" : "off"}`, children: /* @__PURE__ */ jsx("span", { className: "skill-target-thumb" }) }),
      ],
    }
  );
}
