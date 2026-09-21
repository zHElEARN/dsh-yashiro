/** QQ 侧的会话形状，全插件共用一套说法 */

/** group = 群聊，c2c = 单聊 */
export type Scope = "group" | "c2c";

/** 发到哪儿：群 openid 或用户 openid */
export interface PeerRef {
  scope: Scope;
  peerId: string;
}

/** 历史库与绑定表的键：某个 appId 下的一个 QQ 会话 */
export interface ChatKey extends PeerRef {
  appId: string;
}

export function chatKey(appId: string, peer: PeerRef): ChatKey {
  return { appId, scope: peer.scope, peerId: peer.peerId };
}
