import {
  Cli,
  Bridge,
  AppServiceRegistration,
  MatrixUser,
  MatrixRoom,
  WeakEvent,
  BridgeContext,
  Intent,
  RoomBridgeStore,
  RemoteRoom,
} from "matrix-appservice-bridge";
import { WebSocket } from "ws";
import ReconnectingWebSocket from "reconnecting-websocket";
import {
  S24EmittedLogin,
  S24EmittedLogout,
  S24EmittedMessage,
  S24EmittedStateChange,
  S24User,
  S24WebsocketEvent,
} from "./types";
import Datastore from "nedb";

import * as dotenv from "dotenv";
dotenv.config();

const matrixRooms = (process.env.MATRIX_ROOMS as string).split(",");
const s24Rooms = (process.env.S24_ROOMS as string).split(",");

const myUser = process.env.MY_USER || "@teemu:matrix.laaksonen.eu";
const s24User = process.env.S24_USER || "suomuurahainen";
const ws = new ReconnectingWebSocket(
  process.env.WEBSOCKET || "ws://127.0.0.1:4000/ws/connect",
  [],
  {
    WebSocket: WebSocket,
    maxReconnectionDelay: 250,
    minReconnectionDelay: 10,
  }
);

const s24IntentSet = new Set<string>();

const bridge: Bridge = new Bridge({
  homeserverUrl: "https://matrix.laaksonen.eu",
  domain: "laaksonen.eu",
  registration: "s24-registration.yaml",
  roomStore: new RoomBridgeStore(
    new Datastore({ filename: "./datastore/rooms.db", autoload: true })
  ),

  controller: {
    onUserQuery: function (queriedUser) {
      return {}; // auto-provision users with no additonal data
    },

    onEvent: async function (request, context) {
      const event = request.getData();
      switch (event.type) {
        case "m.room.message": {
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

const initRooms = async () => {
  const roomstore = bridge.getRoomStore();
  const botIntent = bridge.getIntent("@s24:matrix.laaksonen.eu");
  await botIntent.setDisplayName("Suomi24-Bot");
  if (matrixRooms.length === s24Rooms.length) {
    for (let i = 0; i < matrixRooms.length; i++) {
      const matrixRoom = new MatrixRoom(matrixRooms[i], {
        extras: {
          isDm: false,
        },
      });
      const remoteRoom = new RemoteRoom(s24Rooms[i], {
        username: process.env.S24_USER as string,
        number: Number(s24Rooms[i]),
        isDm: false,
      });
      await roomstore?.linkRooms(matrixRoom, remoteRoom);
      await botIntent.join(matrixRoom.roomId);
    }
  }
};

setInterval(() => {
  s24IntentSet.forEach((intentString) => {
    const intent = bridge.getIntent(intentString);
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
  try {
    const sender = getS24User(message.sender);
    const intent = bridge.getIntent(sender.intent);
    await intent.setDisplayName(sender.username);
    const roomStore = bridge.getRoomStore();

    if (message.private) {
      const targetRooms = await roomStore?.getLinkedMatrixRooms(
        sender.username
      );
      if (targetRooms?.length) {
        await sendMessageToRooms(intent, message.message, sender, targetRooms);
      } else {
        const dmRoom = await intent.createRoom({
          options: {
            is_direct: true,
            invite: [myUser],
          },
          createAsClient: true,
        });
        await intent.sendText(dmRoom.room_id, message.message);
        roomStore?.linkRooms(
          new MatrixRoom(dmRoom.room_id),
          new RemoteRoom(sender.username, {
            isDm: true,
            username: sender.username,
          })
        );
      }
    } else {
      const targetRooms = await roomStore?.getLinkedMatrixRooms(
        `${message.roomId}`
      );
      if (message.target) {
        const target = getS24User(message.target);
        await sendMessageToRooms(
          intent,
          `${getHighlightLink(target)} ${message.message}`,
          sender,
          targetRooms
        );
      } else {
        await sendMessageToRooms(intent, message.message, sender, targetRooms);
      }
    }
  } catch (error) {
    console.error(error);
  }
};

const sendMessageToRooms = async (
  intent: Intent,
  message: string,
  sender: S24User,
  rooms?: MatrixRoom[]
) => {
  if (rooms) {
    await Promise.all(rooms.map((r) => intent.sendText(r.roomId, message)));
    s24IntentSet.add(sender.intent);
    await intent.setPresence("online");
  }
};

const sendEmoteToRooms = async (
  intent: Intent,
  message: string,
  sender: S24User,
  rooms?: MatrixRoom[]
) => {
  if (rooms) {
    await intent.setDisplayName(sender.username)
    await Promise.all(
      rooms.map((r) => {
        intent.sendEvent(r.roomId, "m.room.message", {
          body: message,
          msgtype: "m.emote",
        });
      })
    );
    s24IntentSet.add(sender.intent);
    await intent.setPresence("online");
  }
};

const handleUserLogin = async (login: S24EmittedLogin) => {
  try {
    const s24User = getS24User(login.username);
    const intent = bridge.getIntent(s24User.intent);
    const roomStore = bridge.getRoomStore() as RoomBridgeStore;
    const rooms = await roomStore.getLinkedMatrixRooms(`${login.roomId}`);
    await sendEmoteToRooms(intent, "kirjautui sisään", s24User, rooms);
    s24IntentSet.add(s24User.intent);
    await intent.setPresence("online");
  } catch (error) {
    console.error(error);
  }
};

const handleUserLogout = async (logout: S24EmittedLogout) => {
  try {
    const s24User = getS24User(logout.username);
    const intent = bridge.getIntent(s24User.intent);
    const roomStore = bridge.getRoomStore() as RoomBridgeStore;
    const rooms = await roomStore.getLinkedMatrixRooms(`${logout.roomId}`);
    await sendEmoteToRooms(intent, "kirjautui ulos", s24User, rooms);
    s24IntentSet.delete(s24User.intent);
    await intent.setPresence("offline");
  } catch (error) {
    console.error(error);
  }
};

const handleUserStateChange = async (stateChange: S24EmittedStateChange) => {
  try {
    const s24User = getS24User(stateChange.username);
    const intent = bridge.getIntent(s24User.intent);
    const roomStore = bridge.getRoomStore() as RoomBridgeStore;
    const rooms = await roomStore.getLinkedMatrixRooms(`${stateChange.roomId}`);
    if (stateChange.state === "0") {
      s24IntentSet.add(s24User.intent);
      await sendEmoteToRooms(intent, "palasi paikalle", s24User, rooms);
      await intent.setPresence("online");
    } else if (stateChange.state === "1") {
      s24IntentSet.delete(s24User.intent);
      await sendEmoteToRooms(intent, "poistui paikalta", s24User, rooms);
      await intent.setPresence("unavailable", "Idle");
    }
  } catch (error) {
    console.error(error);
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
    if (
      target.userId.startsWith("@s24_") &&
      !matrixRooms.includes(room.roomId)
    ) {
      const intent = bridge.getIntent(target.userId);
      const base64 = target.localpart.slice(4);
      const username = usernameFromBase64(base64);
      const s24Target = getS24User(username);
      const roomStore = bridge.getRoomStore();
      await intent.join(room.roomId);
      if (!matrixRooms.includes(room.roomId)) {
        await roomStore?.linkRooms(
          room,
          new RemoteRoom(username, {
            isDm: true,
            username: username,
          })
        );
      }
    }
  } catch (error) {
    console.error(error);
  }
};

const roomMessageHandler = async (event: WeakEvent) => {
  try {
    const roomStore = bridge.getRoomStore();
    const targetRooms = await roomStore?.getLinkedRemoteRooms(event.room_id);
    targetRooms?.forEach((r) => {
      if (r.data.isDm) {
        s24Rooms.forEach((roomId) => {
          ws.send(
            JSON.stringify({
              roomId: Number(roomId),
              message: event.content.body,
              target: r.data.username,
              private: true,
            })
          );
        });
      } else {
        ws.send(
          JSON.stringify({
            roomId: r.data["number"],
            message: event.content.body,
          })
        );
      }
    });
  } catch (error) {
    console.error(error);
  }
};

const client = new Cli({
  registrationPath: "s24-registration.yaml",
  generateRegistration: function (reg, callback) {
    reg.setId(AppServiceRegistration.generateToken());
    reg.setHomeserverToken(AppServiceRegistration.generateToken());
    reg.setAppServiceToken(AppServiceRegistration.generateToken());
    reg.setSenderLocalpart("s24");
    reg.addRegexPattern("users", "@s24_.*", true);
    callback(reg);
  },
  run: async function (port, config) {
    await bridge.run(Number(process.env.PORT) || 9000);
    await initRooms();
  },
});

client.run();
