"use client";
import { restoreLocale, t, uiMessage, useLocale } from "@/lib/i18n";
import { PRODUCT_NAME, PRODUCT_INITIALS } from "@/lib/product";
import { useWelcomeGuard } from "./welcome-guard";
import { LanguageMenu } from "./language-menu";
import { useMotionEnvironment } from "./ambient-motion";
import { ActionButton } from "@/components/motion-system";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Circle,
  MessageSquare,
  Orbit,
  RefreshCw,
  Search,
  Settings2,
  Tags,
  X,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { api, type ConnectionState } from "@/lib/api";
import { BrandMark } from "./ui";
import { NoteDraftGuard } from "./note-draft-guard";
import { InteractionProvider } from "./motion-system";

type Notice = { message: string; type: "success" | "error" };
type ShellContext = {
  reduced: boolean;
  systemReduced: boolean;
  setReduced: (value: boolean) => void;
  notify: (message: string, type?: Notice["type"]) => void;
};
const Context = createContext<ShellContext | null>(null);
const motionQuery = "(prefers-reduced-motion: reduce)";
function subscribeMotion(listener: () => void) {
  const media = window.matchMedia(motionQuery);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
const motionSnapshot = () => window.matchMedia(motionQuery).matches;
export function useSpace() {
  const value = useContext(Context);
  if (!value) throw new Error("Space context is missing");
  return value;
}

const destinations = [
  { href: "/", label: "工作台", description: "你的对话空间", icon: MessageSquare },
  { href: "/tags/", label: "标签池", description: "管理真实的知识分类", icon: Tags },
  { href: "/knowledge/", label: "知识宇宙", description: "创建和阅读主题文档", icon: Orbit },
  { href: "/settings/", label: "设置", description: "模型配置、动画与本机连接", icon: Settings2 },
];

const connectionLabels: Record<ConnectionState, string> = {
  checking: "正在连接本机服务",
  online: "本机服务已连接",
  offline: "本机服务未连接",
  error: "本机连接异常",
};

export function ConnectionBadge() {
  useLocale();
  const status = useSyncExternalStore(
    api.subscribe,
    api.getSnapshot,
    () => "checking" as ConnectionState,
  );
  return (
    <div className={`connection-badge ${status}`} aria-live="polite">
      <span className="connection-dot" />
      <span>{t(connectionLabels[status])}</span>
      <ActionButton
        className="icon-button"
        aria-label={t("重新检查连接")}
        disabled={status === "checking"}
        onClick={() => void api.checkConnection().catch(() => undefined)}
      >
        <RefreshCw size={13} className={status === "checking" ? "spin" : ""} />
      </ActionButton>
    </div>
  );
}

function CosmicBackground({ reduced }: { reduced: boolean }) {
  const environment = useMotionEnvironment();
  const stars = Array.from({ length: 110 }, (_, i) => ({
    left: `${(i * 37.13 + 7) % 100}%`,
    top: `${(i * 23.71 + 3) % 100}%`,
    delay: `${-(i % 9)}s`,
    size: i % 19 === 0 ? 2 : i % 3 === 0 ? 1.2 : 0.7,
  }));
  return (
    <div
      className={`cosmos ${reduced ? "still" : ""}`}
      data-paused={!environment.visible || environment.dialogOpen}
      aria-hidden="true"
    >
      <div className="nebula-image" />
      <div className="nebula-wash" />
      {[0, 1].map((layer) => (
        <div className={`stars-layer stars-depth-${layer}`} key={layer}>
          {stars
            .filter((_, index) => index % 2 === layer)
            .map((star, i) => (
              <i
                key={i}
                style={{
                  left: star.left,
                  top: star.top,
                  width: star.size,
                  height: star.size,
                  animationDelay: star.delay,
                }}
              />
            ))}
        </div>
      ))}
      <svg className="cosmic-lines" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
        <path d="M-70 700C230 80 900 35 1620 260M640 1060C950 650 1320 400 1700 310" />
      </svg>
    </div>
  );
}

export function SpaceShell({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const { isWelcome, ready } = useWelcomeGuard();
  const pathname = usePathname();
  const router = useRouter();
  function navigateAfterDismiss(event: { preventDefault: () => void }, href: string) {
    event.preventDefault();
    // Radix closes menus synchronously. Start the route transition after that
    // close completes so it cannot cancel the shared surface animation.
    setTimeout(() => router.push(href), 0);
  }
  const systemReduced = useSyncExternalStore(subscribeMotion, motionSnapshot, () => false);
  const [manualReduced, setManualReduced] = useState(false);
  const reduced = manualReduced || Boolean(systemReduced);
  const [commandOpen, setCommandOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    void api.checkConnection().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!ready || isWelcome) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ready, isWelcome]);

  useEffect(() => {
    restoreLocale();
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = `${PRODUCT_NAME} · ${t("第二大脑")}`;
  }, [locale]);

  useEffect(() => {
    document.documentElement.dataset.motion = reduced ? "reduced" : "full";
  }, [reduced]);

  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timeout);
  }, [notice]);

  return (
    <Context.Provider
      value={{
        reduced,
        systemReduced: Boolean(systemReduced),
        setReduced: setManualReduced,
        notify: (message, type = "success") => setNotice({ message, type }),
      }}
    >
      <InteractionProvider reduced={reduced}>
        <CosmicBackground reduced={reduced} />
        <NoteDraftGuard />
        {isWelcome ? (
          <main id="main-content" className="welcome-main" tabIndex={-1}>
            {children}
          </main>
        ) : ready ? (
          <>
            <a href="#main-content" className="skip-link">
              {t("跳到主要内容")}
            </a>
            <header className="app-header">
              <Link href="/" className="brand" aria-label={t("{0}，返回工作台", [PRODUCT_NAME])}>
                <BrandMark />
                <span>
                  <strong>{PRODUCT_NAME}</strong>
                  <small>{t("第二大脑")}</small>
                </span>
              </Link>
              <nav className="primary-navigation" aria-label={t("主导航")}>
                {destinations.map((item) => (
                  <Link
                    href={item.href}
                    key={item.href}
                    aria-current={pathname === item.href ? "page" : undefined}
                  >
                    <item.icon size={16} />
                    <span>{t(item.label)}</span>
                    {pathname === item.href && (
                      <motion.span
                        className="nav-active-surface"
                        layoutId="primary-navigation"
                        transition={reduced ? { duration: 0 } : undefined}
                      />
                    )}
                  </Link>
                ))}
              </nav>
              <Dialog.Root
                open={commandOpen}
                onOpenChange={(value) => {
                  setCommandOpen(value);
                  if (!value) setQuery("");
                }}
              >
                <Dialog.Trigger className="command-trigger">
                  <Search size={17} />
                  <span>{t("快速前往…")}</span>
                  <kbd>⌘ K</kbd>
                </Dialog.Trigger>
                <Dialog.Portal>
                  <Dialog.Overlay className="dialog-overlay" />
                  <Dialog.Content className="command-dialog">
                    <Dialog.Title className="sr-only">{t("快速前往")}</Dialog.Title>
                    <Dialog.Description className="sr-only">
                      {t("搜索并切换到你的工作空间。")}
                    </Dialog.Description>
                    <div className="command-search">
                      <Search size={18} />
                      <input
                        aria-label={t("搜索空间")}
                        autoComplete="off"
                        placeholder={t("想前往哪个空间？")}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                      <Dialog.Close className="icon-button" aria-label={t("关闭快速前往")}>
                        <X size={16} />
                      </Dialog.Close>
                    </div>
                    <div className="command-results">
                      {destinations
                        .filter((item) =>
                          t(item.label).toLowerCase().includes(query.trim().toLowerCase()),
                        )
                        .map((item) => (
                          <Dialog.Close asChild key={item.href}>
                            <Link
                              href={item.href}
                              onNavigate={(event) => navigateAfterDismiss(event, item.href)}
                            >
                              <item.icon size={19} />
                              <span>
                                <strong>{t(item.label)}</strong>
                                <small>{t(item.description)}</small>
                              </span>
                              <ArrowUpRight size={15} />
                            </Link>
                          </Dialog.Close>
                        ))}
                    </div>
                    {destinations.every(
                      (item) => !t(item.label).toLowerCase().includes(query.trim().toLowerCase()),
                    ) && <p className="command-empty">{t("没有匹配的空间。")}</p>}
                  </Dialog.Content>
                </Dialog.Portal>
              </Dialog.Root>
              <div className="header-actions">
                <LanguageMenu />
                <Dropdown.Root>
                  <Dropdown.Trigger className="space-trigger" aria-label={t("切换空间")}>
                    <Sparkles size={15} aria-hidden="true" />
                    <span>{t("切换空间")}</span>
                    <ChevronDown size={15} />
                  </Dropdown.Trigger>
                  <Dropdown.Portal>
                    <Dropdown.Content className="space-menu" align="end" sideOffset={10}>
                      <Dropdown.Label className="menu-label">{t("你的空间")}</Dropdown.Label>
                      {destinations.map((item) => (
                        <Dropdown.Item asChild key={item.href}>
                          <Link
                            href={item.href}
                            onNavigate={(event) => navigateAfterDismiss(event, item.href)}
                            className={
                              pathname === item.href ||
                              (item.href !== "/" &&
                                pathname?.startsWith(item.href.replace(/\/$/, "")))
                                ? "active"
                                : ""
                            }
                          >
                            <item.icon size={18} />
                            <span>{t(item.label)}</span>
                          </Link>
                        </Dropdown.Item>
                      ))}
                      <Dropdown.Separator className="menu-separator" />
                      <Dropdown.CheckboxItem
                        className="menu-motion"
                        checked={reduced}
                        disabled={Boolean(systemReduced)}
                        onCheckedChange={setManualReduced}
                        onSelect={(event) => event.preventDefault()}
                      >
                        <Circle size={17} />
                        <span>{t("减少动画")}</span>
                        {reduced && <Check size={15} />}
                      </Dropdown.CheckboxItem>
                    </Dropdown.Content>
                  </Dropdown.Portal>
                </Dropdown.Root>
                <span className="avatar" title={t("个人空间")} aria-label={t("个人空间")}>
                  {PRODUCT_INITIALS}
                </span>
              </div>
            </header>
            <main id="main-content" className="main-content" tabIndex={-1}>
              <div className="page-stage">{children}</div>
            </main>
            <footer className="app-footer">
              <span>
                {t("本机原始对话")}
                <span className="footer-divider">·</span>
                {t("个人记忆空间")}
              </span>
              <ConnectionBadge />
            </footer>
          </>
        ) : (
          <main id="main-content" className="welcome-loading">
            <BrandMark />
            <p role="status">{t("正在打开你的记忆宇宙…")}</p>
          </main>
        )}
        <AnimatePresence>
          {notice && (
            <motion.div
              initial={reduced ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className={`toast ${notice.type}`}
              role={notice.type === "error" ? "alert" : "status"}
            >
              <span className="toast-dot" />
              {uiMessage(notice.message)}
              <ActionButton
                className="icon-button"
                aria-label={t("关闭通知")}
                onClick={() => setNotice(null)}
              >
                <X size={15} />
              </ActionButton>
            </motion.div>
          )}
        </AnimatePresence>
      </InteractionProvider>
    </Context.Provider>
  );
}
