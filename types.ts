export type S24WebsocketEvent = {
  event: "message" | "userLogin" | "userLogout" | "userStateChange";
  data:
    | S24EmittedMessage
    | S24EmittedLogin
    | S24EmittedLogout
    | S24EmittedStateChange;
};

export type S24EmittedMessage = {
  sender: string;
  message: string;
  target: string | null;
  private: boolean;
  timestamp: Date | string;
  roomId: number;
};

export type S24EmittedLogout = {
  username: string;
  timestamp: Date | string;
  roomId: number | string;
};

export type S24EmittedLogin = {
  username: string;
  timestamp: Date | string;
  roomId: number | string;
};

export type S24EmittedStateChange = {
  username: string;
  state: number | string;
  timestamp: Date | string;
  roomId: number | string;
};

export type S24User = {
  username: string;
  base64Username: string;
  intent: string;
  dmRoom: string;
};
