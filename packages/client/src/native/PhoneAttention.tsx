import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import type { PushMessage } from "@jaira/shared/browser";
import { openFromOutside, subscribe } from "@jaira/ui/store";

/**
 * What needs the person, on the phone that asked for it (the person, 2026-11-26: the phone is told "if
 * the phone was the input for the last turn … if the desktop was the input, the phone shouldnt"; chosen
 * delivery: "local, while app is alive").
 *
 * The machine sends `attention:device` to this device alone, about a conversation whose latest message
 * came from here (`deviceAttention.ts` in the service). While the app is not in front it becomes a local
 * notification; tapping one opens the conversation. An ask answered anywhere takes its notification
 * back. Nothing goes through a push service: once the phone suspends the app, its connection — and
 * this — stops until it is opened again.
 */

const CHANNEL = "attention";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

type DevicePush = Extract<PushMessage, { type: "attention:device" }>;

/** The notification's heading for each kind. */
export function headingOf(push: DevicePush): string {
  const name = push.title === "" ? "A conversation" : push.title;
  return push.kind === "asking" ? `${name} is asking` : push.kind === "replied" ? `${name} replied` : `${name} failed`;
}

export function PhoneAttention(): null {
  useEffect(() => {
    void (async () => {
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync(CHANNEL, { name: "Needs you", importance: Notifications.AndroidImportance.HIGH });
      }
      const now = await Notifications.getPermissionsAsync();
      if (!now.granted && now.canAskAgain) await Notifications.requestPermissionsAsync();
    })().catch(() => undefined);

    const off = subscribe((message: PushMessage) => {
      if (message.type !== "attention:device") return;
      const id = message.requestId ?? `${message.kind}:${message.taskId}`;
      if (message.kind === "resolved") {
        void Notifications.dismissNotificationAsync(id).catch(() => undefined);
        return;
      }
      // In front, the app itself shows it.
      if (AppState.currentState === "active") return;
      void Notifications.scheduleNotificationAsync({
        identifier: id,
        content: { title: headingOf(message), body: message.body, data: { taskId: message.taskId, ...(message.project !== undefined ? { project: message.project } : {}) } },
        trigger: Platform.OS === "android" ? { channelId: CHANNEL } : null,
      }).catch(() => undefined);
    });

    const tapped = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { taskId?: unknown; project?: unknown } | undefined;
      if (typeof data?.taskId === "string") openFromOutside(data.taskId, typeof data.project === "string" ? data.project : undefined);
    });
    return () => {
      off();
      tapped.remove();
    };
  }, []);
  return null;
}
