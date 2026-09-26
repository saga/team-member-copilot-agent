import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Layout } from 'antd';

const { Sider } = Layout;

/**
 * 宽度上下界。
 *
 * 下界不是「美观」而是「还能用」：Member row 上是 name + status + Chat/Edit
 * 两个按钮，再窄就会把按钮挤到换行、整个列表变成一列按钮。
 * 上界是「别把正文挤没」：正文里是对话流，左栏宽过 640 之后它就不再是侧栏。
 */
const MIN_WIDTH = 240;
const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 320;

/** 拖动步长（键盘）；按住 Shift 走大步。 */
const KEY_STEP = 8;
const KEY_STEP_LARGE = 32;

/**
 * 宽度存在 localStorage 里。
 *
 * 这是**用户偏好**，不是业务状态 —— 刷新页面后回到默认宽度，会让人以为
 * 「拖了个寂寞」。存不下（隐私模式 / 配额）就退回默认值，不能因为读不到
 * 偏好就让侧栏起不来。
 */
const STORAGE_KEY = 'tmca.sider.width';

function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

function readStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_WIDTH : clampWidth(Number.parseInt(raw, 10));
  } catch {
    return DEFAULT_WIDTH;
  }
}

function writeStoredWidth(value: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // 存不下就算了：宽度不是关键状态，下次进来回到默认值而已。
  }
}

interface ResizableSiderProps {
  children: ReactNode;
}

/**
 * 可拖拽调宽度的左栏。
 *
 * ── 为什么不用 antd 自带的 ────────────────────────────────────────────
 *
 * `Layout.Sider` 的 `collapsible` 只有「展开 / 收起」两态，没有中间宽度；
 * 而这里要的是「让我把它调到刚好放得下 Member 那一行」。加
 * `react-resizable` 只为一个 6px 的拖拽条引入一个依赖，不划算 ——
 * Pointer Events 原生就能做，而且能顺手把键盘可达性一起做了。
 *
 * ── 三个容易漏的细节 ──────────────────────────────────────────────────
 *
 * 1. **指针捕获**：不捕获的话，鼠标一离开那 6px 拖拽条，`pointermove` 就
 *    不再发到这个元素上，拖拽会在最需要它的时刻断掉。
 * 2. **拖动中禁掉文本选中**：指针被捕获了，但光标划过正文时浏览器仍然会
 *    开始选中文字 —— 一次拖拽下来满屏蓝底。
 * 3. **滚动条在拖拽条下面**：滚动容器不能是 Sider 自己，否则
 *    `position: absolute` 的拖拽条会跟着内容一起滚走。所以滚动挪到
 *    `.resizable-sider-body` 上，Sider 只做定位上下文。
 */
export function ResizableSider({ children }: ResizableSiderProps) {
  const [width, setWidth] = useState(readStoredWidth);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  // 拖动中：全局禁选 + 全局 col-resize。光标离开拖拽条时也要保持手感一致。
  useEffect(() => {
    if (!dragging) return;
    const { userSelect, cursor } = document.body.style;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      document.body.style.userSelect = userSelect;
      document.body.style.cursor = cursor;
    };
  }, [dragging]);

  /** 落盘 + 落状态。只在「一次拖拽结束 / 一次键盘调整」时调用。 */
  const commit = useCallback((next: number) => {
    const clamped = clampWidth(next);
    setWidth(clamped);
    writeStoredWidth(clamped);
  }, []);

  function endDrag(): void {
    dragRef.current = null;
    setDragging(false);
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    // 只接主键：右键菜单 / 中键粘贴不该开始拖拽。
    if (event.button !== 0) return;
    // 阻止默认行为，否则拖动过程中会开始选中文字。
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    setDragging(true);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    // 拖动中只更新状态、不写 localStorage：pointermove 是每帧一次，
    // 同步写盘会把拖拽拖成幻灯片。落盘留到 pointerup。
    setWidth(clampWidth(drag.startWidth + (event.clientX - drag.startX)));
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    commit(drag.startWidth + (event.clientX - drag.startX));
    endDrag();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const next =
      event.key === 'ArrowLeft'
        ? width - step
        : event.key === 'ArrowRight'
          ? width + step
          : event.key === 'Home'
            ? DEFAULT_WIDTH
            : null;
    if (next === null) return;
    event.preventDefault();
    commit(next);
  }

  return (
    <Sider width={width} theme="light" className="resizable-sider">
      <div className="resizable-sider-body">{children}</div>

      <div
        className={`resizable-sider-handle${dragging ? ' resizable-sider-handle--active' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整左栏宽度"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        // 捕获被系统抢走（切窗口、触屏手势）时也要收尾，否则 dragging 卡在 true，
        // 整页一直处于「禁选 + col-resize」。
        onLostPointerCapture={endDrag}
        onPointerCancel={endDrag}
        // 双击回到默认宽度：调窄了想复原不必对着像素找。
        onDoubleClick={() => commit(DEFAULT_WIDTH)}
        onKeyDown={onKeyDown}
      />
    </Sider>
  );
}
