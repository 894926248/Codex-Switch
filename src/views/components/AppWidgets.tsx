import type { CSSProperties } from "react";
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
} from "../../utils";
import type { ProfileView } from "../../types";

interface SortableProfileCardProps {
  profile: ProfileView;
  index: number;
  selected: boolean;
  isModeActive: boolean;
  busy: boolean;
  showLiveQuerying?: boolean;
  isQuotaRefreshing?: boolean;
  liveQueryError?: string | null;
  onSelect: (name: string) => void;
  onRefreshQuota: (name: string) => void;
  onApply: (name: string) => void;
  onSetAlias: (name: string) => void;
  onDelete: (name: string) => void;
}

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
}: SortableProfileCardProps) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: profile.name,
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    animationDelay: `${Math.min(index * 45, 320)}ms`,
  };
  const statusText = stripCurrentActiveSuffix(profile.status);
  const compactError = (raw?: string | null): string | null => {
    const text = (raw || "").trim();
    if (!text) {
      return null;
    }
    return text.length > 72 ? `${text.slice(0, 72)}...` : text;
  };
  const liveError = compactError(liveQueryError);

  return (
    <div ref={setNodeRef} style={style} className={`sortable-item ${isDragging ? "sorting-item-dragging" : ""}`}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: card root supports click-to-select while keeping nested action buttons valid */}
      <div
        className={`profile-card ${selected ? "selected" : ""} ${isModeActive ? "active" : ""} ${
          isDragging ? "dragging-source" : ""
        }`}
        onMouseDown={(event) => {
          if (event.button === 0) {
            onSelect(profile.name);
          }
        }}
      >
        <button
          type="button"
          className="card-left-icon drag-handle"
          title="拖拽调整顺序"
          aria-label={`拖拽调整顺序: ${profile.displayWorkspace}`}
          onClick={(e) => e.stopPropagation()}
          {...attributes}
          {...listeners}
        >
          ⋮⋮
        </button>
        <div className="card-main">
          <div className="workspace-title">
            <span className="profile-no">#{index + 1}</span>
            <span className="workspace-name">{profile.displayWorkspace}</span>
          </div>
          <div className="email-line">{profile.email || "-"}</div>
          <div className="quota-line">
            <span className={`quota-pill quota-pill-week ${quotaClass(profile.oneWeekRemainingPercent)}`}>
              <strong>1 周</strong>
              <b>{pct(profile.oneWeekRemainingPercent)}</b>
              <small>{formatReset(profile.oneWeekResetsAt)}</small>
            </span>
            <span className={`quota-pill quota-pill-hour ${quotaClass(profile.fiveHourRemainingPercent)}`}>
              <strong>5 小时</strong>
              <b>{pct(profile.fiveHourRemainingPercent)}</b>
              <small>{formatReset(profile.fiveHourResetsAt, "time")}</small>
            </span>
          </div>
          <div className="meta-line">
            {isQuotaRefreshing ? (
              <span className="meta-querying">
                <span className="meta-spinner" aria-hidden />
                <span>配额查询中...</span>
              </span>
            ) : showLiveQuerying && liveError ? (
              <span className="meta-error" title={liveQueryError || undefined}>
                配额实时查询失败: {liveError}
              </span>
            ) : showLiveQuerying ? (
              <span className="meta-querying">
                <span className="meta-spinner" aria-hidden />
                <span>配额实时查询中...</span>
              </span>
            ) : (
              `最近刷新: ${formatCheckedAt(profile.lastCheckedAt)}`
            )}
          </div>
        </div>
        <div className="card-side">
          <div className="support-badge-row">
            {isModeActive ? <span className="mode-active-chip">当前生效</span> : null}
            <span className={`support-badge ${supportBadgeClass(profile.support)}`}>
              {supportBadgeText(profile.support)}
            </span>
          </div>
          <div className="status-row">
            <span className={`status-pill ${statusClass(statusText)}`}>{statusText}</span>
            <button
              type="button"
              className={`mini-icon ${isQuotaRefreshing ? "mini-icon-querying" : ""}`}
              disabled={busy}
              title={isQuotaRefreshing ? "配额查询中..." : "刷新此账号额度"}
              aria-label={isQuotaRefreshing ? "配额查询中" : "刷新此账号额度"}
              onClick={(e) => {
                e.stopPropagation();
                onRefreshQuota(profile.name);
              }}
            >
              <span className={isQuotaRefreshing ? "icon-spin" : undefined} aria-hidden>
                ↻
              </span>
            </button>
          </div>
          <div className="action-rail">
            <button
              type="button"
              className="card-action primary"
              disabled={busy || isModeActive}
              onClick={(e) => {
                e.stopPropagation();
                onApply(profile.name);
              }}
            >
              {isModeActive ? "使用中" : "使用"}
            </button>
            <button
              type="button"
              className="card-action"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onSetAlias(profile.name);
              }}
            >
              改名
            </button>
            <button
              type="button"
              className="card-action danger"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(profile.name);
              }}
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function McpIcon({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      fill="currentColor"
      fillRule="evenodd"
      height={size}
      width={size}
      className={className}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <title>MCP</title>
      <path d="M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z" />
      <path d="M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z" />
    </svg>
  );
}

interface SkillTargetSwitchProps {
  label: string;
  icon?: string;
  checked: boolean;
  busy: boolean;
  onClick: () => void;
}

export function SkillTargetSwitch({ label, icon, checked, busy, onClick }: SkillTargetSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`skill-target-switch ${checked ? "on" : "off"}`}
      onClick={onClick}
      disabled={busy}
    >
      <span className="skill-target-label">
        {icon ? <img src={icon} alt={`${label} icon`} className="skill-target-icon" /> : <span aria-hidden className="skill-target-dot" />}
        <span>{label}</span>
      </span>
      <span className={`skill-target-track ${checked ? "on" : "off"}`}>
        <span className="skill-target-thumb" />
      </span>
    </button>
  );
}
