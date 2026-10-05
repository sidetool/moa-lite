import { useNavigation, tabPath } from "../lib/navigation";
import { hasLoginGate } from "../lib/api";
import { Info, Bookmark, FolderOpen, History, House, LogOut, Search, Settings, UserRound, Users, UsersRound, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { Profile } from "@moa/shared";
import { useMe, useProfiles } from "../api/queries";
import { logout } from "../pages/AccountsPage";
import { currentProfileId, setCurrentProfileId } from "../lib/api";
import { PROFILE_COLOR, cx } from "../lib/format";
import { settledQuery, useSettledQuery } from "../lib/search-input";
import { AvatarArt, avatarSpec } from "./avatars";



export function Avatar({ profile, size = 32 }: { profile?: Pick<Profile, "name" | "color" | "avatar">; size?: number }) {
  if (profile?.avatar && avatarSpec(profile.avatar)) return <span className="avatar has-art" style={{ width: size, height: size }} aria-hidden="true"><AvatarArt id={profile.avatar} /></span>;
  return (
    <span className="avatar" style={{ width: size, height: size, background: PROFILE_COLOR[profile?.color ?? "violet"] ?? PROFILE_COLOR.violet, fontSize: size * .42 }} aria-hidden="true">
      {Array.from(profile?.name.trim() ?? "")[0] ?? ""}
    </span>
  );
}

export function Logo() {
  return <span className="logo" aria-label="MOA">MOA<i /></span>;
}

function useScrolled() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return scrolled;
}

function SearchBox({ onClose }: { onClose?: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [value, setValue] = useState(location.pathname === "/search" ? params.get("q") ?? "" : "");
  const input = useRef<HTMLInputElement>(null);
  const origin = useRef<string | null>(null);

  useEffect(() => { input.current?.focus(); }, []);

  const onSearch = location.pathname === "/search";
  const committed = onSearch ? params.get("q") ?? "" : "";
  // Typing opens /search right away; the query itself follows once typing settles (replace, so
  // Back returns to where the search started).
  const go = (query: string) => {
    if (!onSearch) origin.current = location.pathname + location.search;
    navigate(query ? `/search?q=${encodeURIComponent(query)}` : "/search", { replace: onSearch });
  };
  const update = (next: string) => {
    setValue(next);
    if (!onSearch && next) go(committed);
  };
  // Follow the URL when the query changes elsewhere (the search page box, Back), so this box never commits a stale value.
  useEffect(() => { setValue(current => settledQuery(current) === committed ? current : committed); }, [committed]); // eslint-disable-line react-hooks/exhaustive-deps
  useSettledQuery(value, committed, go);

  return (
    <div className="searchbox">
      <Search size={18} aria-hidden="true" />
      <input
        ref={input}
        type="search"
        value={value}
        placeholder="제목, 장르 검색"
        aria-label="검색"
        onChange={event => update(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Escape") onClose?.();
          if (event.key === "Enter") { const query = settledQuery(event.currentTarget.value); if (query !== committed) go(query); }
        }}
      />
      {value && <button className="searchbox-clear" aria-label="지우기" onClick={() => { setValue(""); go(""); input.current?.focus(); }}><X size={16} /></button>}
    </div>
  );
}

function ProfileMenu({ profile }: { profile?: Profile }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const me = useMe();
  const admin = me.data?.role === "admin";
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const item = (to: string, icon: ReactNode, label: string) => (
    <Link to={to} className="menu-item" role="menuitem" onClick={() => setOpen(false)}>{icon}{label}</Link>
  );
  return (
    <div className="profile-menu" ref={root}>
      <button className="profile-trigger" aria-haspopup="menu" aria-expanded={open} aria-label="프로필 메뉴" onClick={() => setOpen(value => !value)}>
        <Avatar profile={profile} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head"><Avatar profile={profile} size={36} /><b>{profile?.name}</b></div>
          {item("/history", <History size={18} />, "시청 기록")}
          {admin && item("/sources", <FolderOpen size={18} />, "영상 소스")}
          {admin && import.meta.env.VITE_MOA_LITE !== "1" && item("/library", <FolderOpen size={18} />, "라이브러리 관리")}
          {admin && hasLoginGate && item("/accounts", <Users size={18} />, "계정과 초대")}
          {item("/settings", <Settings size={18} />, "설정")}
          {item("/about", <Info size={18} />, "정보/크레딧")}
          <button className="menu-item" role="menuitem" onClick={() => { setCurrentProfileId(null); navigate("/profiles"); }}>
            <UsersRound size={18} />프로필 전환
          </button>
          {hasLoginGate && <button className="menu-item" role="menuitem" onClick={() => void logout()}><LogOut size={18} />로그아웃{me.data && <small className="menu-item-sub">{me.data.username}</small>}</button>}
        </div>
      )}
    </div>
  );
}

export function AppShell() {
  const scrolled = useScrolled();
  const { tabs } = useNavigation();
  const sections = [...tabs.map(t => ({ to: tabPath(t.id), label: t.name, end: true })), { to: "/my-list", label: "내 목록", end: true }];
  const location = useLocation();
  const profiles = useProfiles();
  const profile = profiles.data?.find(item => item.id === currentProfileId());
  const [searchOpen, setSearchOpen] = useState(location.pathname === "/search");
  const overHero = ["/", "/series", "/movies", "/anime"].includes(location.pathname) || location.pathname.startsWith("/tabs/") || location.pathname === "/local" || location.pathname.startsWith("/title/");

  useEffect(() => { if (location.pathname === "/search") setSearchOpen(true); }, [location.pathname]);
  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === "/" && !/input|textarea|select/i.test(target.tagName)) { event.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="shell">
      <header className={cx("topnav", (scrolled || !overHero) && "is-solid", location.pathname.startsWith("/title/") && "topnav-detail")} data-remote-group data-remote-edge>
        <Link to="/" className="topnav-logo" aria-label="MOA 홈"><Logo /></Link>
        <nav className="topnav-links" aria-label="주요 메뉴">
          {sections.map(section => (
            <NavLink key={section.to} to={section.to} end={section.end} className={({ isActive }) => cx("topnav-link", isActive && "is-active")}>{section.label}</NavLink>
          ))}
        </nav>
        <div className="topnav-tools">
          {searchOpen
            ? <SearchBox onClose={() => setSearchOpen(false)} />
            : <button className="icon-btn" aria-label="검색 (/)" title="검색 (/)" onClick={() => setSearchOpen(true)}><Search size={22} /></button>}
          <ProfileMenu profile={profile} />
        </div>
      </header>

      <main className="page">
        <Outlet />
      </main>

      <nav className="tabbar" aria-label="하단 메뉴">
        <NavLink to="/" end className={({ isActive }) => cx("tab", isActive && "is-active")}><House size={22} /><span>홈</span></NavLink>
        <NavLink to="/search" className={({ isActive }) => cx("tab", isActive && "is-active")}><Search size={22} /><span>검색</span></NavLink>
        <NavLink to="/my-list" className={({ isActive }) => cx("tab", isActive && "is-active")}><Bookmark size={22} /><span>내 목록</span></NavLink>
        <NavLink to="/me" className={({ isActive }) => cx("tab", isActive && "is-active")}><UserRound size={22} /><span>마이</span></NavLink>
      </nav>
    </div>
  );
}
