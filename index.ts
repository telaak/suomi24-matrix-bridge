import {
  Cli,
  Bridge,
  AppServiceRegistration,
  MatrixUser,
  MatrixRoom,
  WeakEvent,
  BridgeContext,
  Intent,
} from "matrix-appservice-bridge";
import { WebSocket } from "ws";
import { Level } from "level";
import ReconnectingWebSocket from "reconnecting-websocket";
import {
  S24EmittedLogin,
  S24EmittedLogout,
  S24EmittedMessage,
  S24EmittedStateChange,
  S24User,
  S24WebsocketEvent,
} from "./types";

import * as dotenv from "dotenv";
dotenv.config();

const db = new Level("rooms", { valueEncoding: "json" });
const putJson = async (key: string, value: any) => {
  await db.put(key, value, { valueEncoding: "json" });
};
const getJson = async (key: string) => {
  const result: S24User = await db.get(key, { valueEncoding: "json" });
  return result;
};
let bridge: Bridge;
const roomId =
  process.env.MATRIX_ROOM || "!hoyDciBnqRcijNEuzw:matrix.laaksonen.eu";
const myUser = process.env.MY_USER || "@teemu:matrix.laaksonen.eu";
const s24User = process.env.S24_USER || "suomuurahainen";
const s24Room = Number(process.env.S24_ROOM) || 953;
const ws = new ReconnectingWebSocket(
  process.env.WEBSOCKET || "ws://127.0.0.1:4000/ws/connect",
  [],
  {
    WebSocket: WebSocket,
    maxReconnectionDelay: 250,
    minReconnectionDelay: 10,
  }
);

const s24IntentSet = new Set<Intent>();

setInterval(() => {
  s24IntentSet.forEach((intent) => {
    intent.setPresence("online");
  });
}, 1000 * 20);

const usernameToBase64 = (username: string) => {
  const stringBuffer = Buffer.from(username);
  return stringBuffer.toString("base64");
};

const usernameFromBase64 = (base64: string) => {
  const stringBuffer = Buffer.from(base64, "base64");
  return stringBuffer.toString();
};

const getIntent = (base64Username: string) => {
  const intent = `@s24_${base64Username}:matrix.laaksonen.eu`;
  return intent;
};

const getS24User = (username: string) => {
  const base64Username = usernameToBase64(username);
  const intent = getIntent(base64Username);
  const dmRoom = getDmRoom(base64Username);
  const user: S24User = {
    username,
    base64Username,
    intent,
    dmRoom,
  };
  return user;
};

const getHighlightLink = (user: S24User) => {
  return `https://matrix.to/#/${user.intent}`;
};

const getDmRoom = (base64Username: string) => {
  const dmRoom = `#s24dm_${base64Username}:matrix.laaksonen.eu`;
  return dmRoom;
};

const handleMessageEvent = async (message: S24EmittedMessage) => {
  if (message.sender === s24User) return;
  const sender = getS24User(message.sender);
  const intent = bridge.getIntent(sender.intent);
  intent.setDisplayName(sender.username);
  if (message.private) {
    try {
      const checkRoom = await intent.resolveRoom(sender.dmRoom);
      await putJson(checkRoom, sender);
      await intent.sendText(checkRoom, message.message);
      s24IntentSet.add(intent);
      await intent.setPresence("online");
      // await intent.invite(checkRoom, myUser);
    } catch (error) {
      const dmRoom = await intent.createRoom({
        options: {
          is_direct: true,
          invite: [myUser],
        },
        createAsClient: true,
      });
      await intent.sendText(dmRoom.room_id, message.message);
      s24IntentSet.add(intent);
      await intent.setPresence("online");
      await intent.createAlias(sender.dmRoom, dmRoom.room_id);
      await putJson(dmRoom.room_id, sender);
    }
  } else if (message.target) {
    const target = getS24User(message.target);
    await intent.sendText(
      roomId,
      `${getHighlightLink(target)} ${message.message}`
    );
    s24IntentSet.add(intent);
    await intent.setPresence("online");
  } else {
    await intent.sendText(roomId, message.message);
    s24IntentSet.add(intent);
    await intent.setPresence("online");
  }
};

const handleUserLogin = async (login: S24EmittedLogin) => {
  const s24User = getS24User(login.username);
  const intent = bridge.getIntent(s24User.intent);
  s24IntentSet.add(intent);
  await intent.setPresence("online");
};

const handleUserLogout = async (logout: S24EmittedLogout) => {
  const s24User = getS24User(logout.username);
  const intent = bridge.getIntent(s24User.intent);
  s24IntentSet.delete(intent);
  await intent.setPresence("offline");
};

const handleUserStateChange = async (stateChange: S24EmittedStateChange) => {
  const s24User = getS24User(stateChange.username);
  const intent = bridge.getIntent(s24User.intent);
  if (stateChange.state === "0") {
    s24IntentSet.add(intent);
    await intent.setPresence("online");
  } else if (stateChange.state === "1") {
    s24IntentSet.delete(intent);
    await intent.setPresence("unavailable", "Idle");
  }
};

// @ts-ignore:next-line
ws.addEventListener("message", async (messageEvent) => {
  try {
    const text = messageEvent.data.toString();
    const json: S24WebsocketEvent = JSON.parse(text);
    switch (json.event) {
      case "message": {
        handleMessageEvent(json.data as S24EmittedMessage);
        break;
      }
      case "userLogin": {
        handleUserLogin(json.data as S24EmittedLogin);
        break;
      }
      case "userLogout": {
        handleUserLogout(json.data as S24EmittedLogout);
        break;
      }
      case "userStateChange": {
        handleUserStateChange(json.data as S24EmittedStateChange);
        break;
      }
    }
  } catch (error) {
    console.error(error);
  }
});

const roomMemberHandler = async (event: WeakEvent, context: BridgeContext) => {
  try {
    const inviter = context?.senders.matrix as MatrixUser;
    const target = context?.targets.matrix as MatrixUser;
    const room = context?.rooms.matrix as MatrixRoom;
    if (target.userId.startsWith("@s24_")) {
      const intent = bridge.getIntent(target.userId);
      await intent.join(room.roomId);
      const base64 = target.localpart.slice(4);
      const username = usernameFromBase64(base64);
      const s24Target = getS24User(username);
      await putJson(room.roomId, s24Target);
    }
  } catch (error) {
    console.error(error);
  }
};

const roomMessageHandler = async (event: WeakEvent) => {
  if (event.room_id === roomId) {
    try {
      ws.send(
        JSON.stringify({
          roomId: s24Room,
          message: event.content.body,
        })
      );
    } catch (error) {
      console.error(error);
    }
  } else {
    try {
      const target: S24User = await getJson(event.room_id);
      ws.send(
        JSON.stringify({
          roomId: s24Room,
          message: event.content.body,
          target: target.username,
          private: true,
        })
      );
    } catch (error) {
      console.error(error);
      setTimeout(() => {
        roomMessageHandler(event);
      }, 500);
    }
  }
};

const client = new Cli({
  registrationPath: "s24-registration.yaml",
  generateRegistration: function (reg, callback) {
    reg.setId(AppServiceRegistration.generateToken());
    reg.setHomeserverToken(AppServiceRegistration.generateToken());
    reg.setAppServiceToken(AppServiceRegistration.generateToken());
    reg.setSenderLocalpart("s24");
    reg.addRegexPattern("users", "'@s24_.*'", true);
    callback(reg);
  },
  run: function (port, config) {
    bridge = new Bridge({
      homeserverUrl: "https://matrix.laaksonen.eu",
      domain: "laaksonen.eu",
      registration: "s24-registration.yaml",

      controller: {
        onUserQuery: function (queriedUser) {
          return {}; // auto-provision users with no additonal data
        },

        onEvent: async function (request, context) {
          const event = request.getData();
          console.log(context);
          console.log(event);

          switch (event.type) {
            case "m.room.message": {
              console.log(event.type);
              roomMessageHandler(event);
              break;
            }
            case "m.room.member": {
              roomMemberHandler(event, context as BridgeContext);
              break;
            }
            default: {
              //   console.log(event);
              //   console.log(context);
            }
          }
        },
      },
    });
    bridge.run(Number(process.env.PORT) || 9000);
  },
});

client.run();
