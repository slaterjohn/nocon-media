import {
  Home, Library, Tv, ListVideo, FolderOpen, Clock, PlayCircle, Heart, Search,
  LayoutDashboard, Rss, Download, HardDrive, Compass, Database, MonitorSmartphone, Activity, Settings, HeartPulse,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
}

export const watchNav: NavItem[] = [
  { href: "/", label: "Home", icon: Home, exact: true },
  { href: "/library", label: "Library", icon: Library },
  { href: "/channels", label: "Channels", icon: Tv },
  { href: "/playlists", label: "Playlists", icon: ListVideo },
  { href: "/collections", label: "Collections", icon: FolderOpen },
  { href: "/recent", label: "Recently added", icon: Clock },
  { href: "/continue", label: "Continue watching", icon: PlayCircle },
  { href: "/favourites", label: "Favourites", icon: Heart },
  { href: "/search", label: "Search", icon: Search },
];

export const manageNav: NavItem[] = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/admin/sources", label: "Sources", icon: Rss },
  { href: "/admin/downloads", label: "Downloads", icon: Download },
  { href: "/admin/media", label: "Media library", icon: Database },
  { href: "/admin/discovery", label: "Discovery", icon: Compass },
  { href: "/admin/storage", label: "Storage", icon: HardDrive },
  { href: "/admin/clients", label: "External players", icon: MonitorSmartphone },
  { href: "/admin/activity", label: "Activity", icon: Activity },
  { href: "/admin/settings", label: "Settings", icon: Settings },
  { href: "/admin/system", label: "System health", icon: HeartPulse },
];
