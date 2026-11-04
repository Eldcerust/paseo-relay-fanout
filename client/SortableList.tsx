import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Easing,
  PanResponder,
  Platform,
  View,
  type GestureResponderHandlers,
  type PanResponderInstance,
  type ViewStyle,
} from "react-native";

/** What a row spreads onto its drag handle. */
export interface DragHandle {
  panHandlers: GestureResponderHandlers;
  /** Cursor and touch rules the web needs so a drag is not taken for a scroll or a text selection. */
  style: ViewStyle | null;
  /** Move one place up (-1) or down (1), for assistive technology that cannot drag. */
  moveBy(delta: -1 | 1): void;
}

export interface SortableListProps<T> {
  items: readonly T[];
  getKey(item: T): string;
  /** Every row has this height, which keeps the drop position a plain division. */
  rowHeight: number;
  gap: number;
  /** When false the rows are plain and the handle does nothing. */
  enabled: boolean;
  /** The keys in their new order, after a drop. */
  onReorder(keys: string[]): void;
  renderRow(item: T, index: number, handle: DragHandle, dragging: boolean): ReactNode;
}

interface Session {
  key: string;
  from: number;
  over: number;
}

interface Controller {
  begin(key: string): void;
  move(dy: number): void;
  end(commit: boolean): void;
  moveBy(key: string, delta: -1 | 1): void;
}

const WEB_HANDLE_STYLE = { cursor: "grab", touchAction: "none", userSelect: "none" } as unknown as ViewStyle;

function relocate(keys: string[], from: number, to: number): string[] {
  const next = [...keys];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/**
 * A list whose rows are reordered by dragging their handle. The row being dragged follows the
 * pointer while the rows it passes slide aside, and the new order is reported once on release.
 */
export function SortableList<T>({ items, getKey, rowHeight, gap, enabled, onReorder, renderRow }: SortableListProps<T>) {
  const keys = items.map(getKey);
  const stride = rowHeight + gap;

  const [drag, setDrag] = useState<Session | null>(null);
  const session = useRef<Session | null>(null);
  const dragY = useRef(new Animated.Value(0)).current;
  const shifts = useRef(new Map<string, Animated.Value>()).current;
  // The controller is created once, so it reads the latest props from here.
  const live = useRef({ keys, stride, enabled, onReorder });
  live.current = { keys, stride, enabled, onReorder };

  const shiftOf = (key: string): Animated.Value => {
    let value = shifts.get(key);
    if (!value) {
      value = new Animated.Value(0);
      shifts.set(key, value);
    }
    return value;
  };

  const controller = useRef<Controller | null>(null);
  if (!controller.current) {
    controller.current = {
      begin(key) {
        const { keys: current, enabled: on } = live.current;
        const from = current.indexOf(key);
        if (!on || from < 0) return;
        session.current = { key, from, over: from };
        dragY.setValue(0);
        setDrag(session.current);
      },
      move(dy) {
        const active = session.current;
        if (!active) return;
        const { keys: current, stride: step } = live.current;
        const last = current.length - 1;
        // Keep the row inside the list.
        const clamped = Math.max(-active.from * step, Math.min((last - active.from) * step, dy));
        dragY.setValue(clamped);
        const over = Math.max(0, Math.min(last, Math.round(active.from + clamped / step)));
        if (over !== active.over) {
          session.current = { ...active, over };
          setDrag(session.current);
        }
      },
      end(commit) {
        const active = session.current;
        session.current = null;
        // Reset before the new order renders, so no row flashes at its old offset.
        dragY.setValue(0);
        for (const value of shifts.values()) value.setValue(0);
        setDrag(null);
        if (commit && active && active.over !== active.from) {
          live.current.onReorder(relocate(live.current.keys, active.from, active.over));
        }
      },
      moveBy(key, delta) {
        const { keys: current, enabled: on } = live.current;
        const from = current.indexOf(key);
        const to = from + delta;
        if (!on || from < 0 || to < 0 || to >= current.length) return;
        live.current.onReorder(relocate(current, from, to));
      },
    };
  }

  // Slide the rows the dragged one passes out of its way.
  useEffect(() => {
    if (!drag) return;
    keys.forEach((key, index) => {
      if (key === drag.key) return;
      let target = 0;
      if (index > drag.from && index <= drag.over) target = -stride;
      else if (index < drag.from && index >= drag.over) target = stride;
      Animated.timing(shiftOf(key), {
        toValue: target,
        duration: 140,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  // A row that disappears while it is held cannot be dropped, so let it go.
  useEffect(() => {
    if (session.current && !keys.includes(session.current.key)) controller.current?.end(false);
  }, [keys.join("\u0000")]);

  return (
    <View>
      {items.map((item, index) => {
        const key = keys[index]!;
        return (
          <SortableRow
            key={key}
            itemKey={key}
            controller={controller.current!}
            dragging={drag?.key === key}
            translateY={drag?.key === key ? dragY : shiftOf(key)}
            height={rowHeight}
            marginBottom={index === items.length - 1 ? 0 : gap}
            enabled={enabled}
            render={(handle, dragging) => renderRow(item, index, handle, dragging)}
          />
        );
      })}
    </View>
  );
}

function SortableRow({
  itemKey,
  controller,
  dragging,
  translateY,
  height,
  marginBottom,
  enabled,
  render,
}: {
  itemKey: string;
  controller: Controller;
  dragging: boolean;
  translateY: Animated.Value;
  height: number;
  marginBottom: number;
  enabled: boolean;
  render(handle: DragHandle, dragging: boolean): ReactNode;
}) {
  const responder = useRef<PanResponderInstance | null>(null);
  if (!responder.current) {
    responder.current = PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Once a row is held, a scrolling parent must not take the gesture away.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => controller.begin(itemKey),
      onPanResponderMove: (_event, gesture) => controller.move(gesture.dy),
      onPanResponderRelease: () => controller.end(true),
      onPanResponderTerminate: () => controller.end(false),
    });
  }

  const handle: DragHandle = {
    panHandlers: enabled ? responder.current.panHandlers : {},
    style: Platform.OS === "web" && enabled ? WEB_HANDLE_STYLE : null,
    moveBy: (delta) => controller.moveBy(itemKey, delta),
  };

  return (
    <Animated.View
      style={{
        // A minimum, so the row being edited can be taller. Rows are only dragged when none is.
        minHeight: height,
        marginBottom,
        zIndex: dragging ? 10 : 0,
        elevation: dragging ? 6 : 0,
        shadowColor: "#000",
        shadowOpacity: dragging ? 0.28 : 0,
        shadowRadius: dragging ? 10 : 0,
        shadowOffset: { width: 0, height: 4 },
        transform: [{ translateY }],
      }}
    >
      {render(handle, dragging)}
    </Animated.View>
  );
}
