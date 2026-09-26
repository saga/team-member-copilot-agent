import { useEffect, useRef } from 'react';
import { api, type TeamEventType } from './api';

const TEAM_EVENT_TYPES: TeamEventType[] = [
  'work_item.changed',
  'schedule.changed',
  'presence.changed',
  'project.changed',
  'membership.changed',
];

/**
 * Team 级实时事件。
 *
 * EventSource 断线自动重连并回传 Last-Event-ID，服务端按 sequence 补发 ——
 * 前端不需要自己记水位，也不需要退回轮询。handler 经 ref 间接调用：
 * 调用方传内联函数不会导致连接反复重建。
 */
export function useTeamEvents(handler: (type: TeamEventType, data: unknown) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const source = new EventSource(api.teamEventsUrl());
    for (const type of TEAM_EVENT_TYPES) {
      source.addEventListener(type, (event) => {
        let data: unknown = null;
        try {
          data = JSON.parse((event as MessageEvent).data);
        } catch {
          // payload 解析失败也通知，调用方可以整表刷新
        }
        handlerRef.current(type, data);
      });
    }
    return () => source.close();
  }, []);
}
