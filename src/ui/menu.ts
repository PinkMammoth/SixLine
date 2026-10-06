// Minimal in-window menu bar (keeps all shortcuts in the renderer, same on every platform).
export interface MenuItem {
  label: string;
  key?: string;
  run: () => void;
  enabled?: () => boolean;
}
export interface MenuDef {
  title: string;
  items: (MenuItem | null)[];
}

export function buildMenus(bar: HTMLElement, menus: MenuDef[]) {
  let open: HTMLElement | null = null;
  const close = () => {
    open?.classList.remove('open');
    open = null;
  };
  for (const m of menus) {
    const el = document.createElement('div');
    el.className = 'menu';
    el.innerHTML = `<div class="title">${m.title}</div><div class="items"></div>`;
    const items = el.querySelector('.items')!;
    const refresh = () => {
      items.innerHTML = '';
      for (const it of m.items) {
        const row = document.createElement('div');
        if (!it) {
          row.className = 'sep';
        } else {
          row.className = 'item' + (it.enabled && !it.enabled() ? ' disabled' : '');
          row.innerHTML = `<span></span><span class="key">${it.key ?? ''}</span>`;
          row.firstElementChild!.textContent = it.label;
          row.onmousedown = (e) => {
            e.preventDefault();
            close();
            it.run();
          };
        }
        items.appendChild(row);
      }
    };
    const title = el.querySelector<HTMLElement>('.title')!;
    title.onmousedown = (e) => {
      e.preventDefault();
      if (open === el) return close();
      close();
      refresh();
      el.classList.add('open');
      open = el;
    };
    title.onmouseenter = () => {
      if (open && open !== el) {
        close();
        refresh();
        el.classList.add('open');
        open = el;
      }
    };
    bar.appendChild(el);
  }
  document.addEventListener('mousedown', (e) => {
    if (open && !open.contains(e.target as Node)) close();
  });
  return { closeMenus: close };
}
