/**
 * The slice of the Telegram Bot API NearKit uses (https://core.telegram.org/bots/api).
 * Fields the bot doesn't read are left out; unknown extra fields are ignored.
 */

export interface TgUser {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
}

export type ChatType = 'private' | 'group' | 'supergroup' | 'channel'

export interface TgChat {
  id: number
  type: ChatType
  title?: string
  username?: string
  first_name?: string
}

export interface TgMessageEntity {
  type: string
  offset: number
  length: number
}

export interface TgMessage {
  message_id: number
  date: number
  chat: TgChat
  from?: TgUser
  /** A channel post or an anonymous group admin. */
  sender_chat?: TgChat
  text?: string
  entities?: TgMessageEntity[]
  reply_to_message?: TgMessage
}

export interface TgCallbackQuery {
  id: string
  from: TgUser
  message?: TgMessage
  data?: string
}

export type ChatMemberStatus = 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked'

export interface TgChatMember {
  status: ChatMemberStatus
  user: TgUser
  can_post_messages?: boolean
}

export interface TgChatMemberUpdated {
  chat: TgChat
  from: TgUser
  date: number
  old_chat_member: TgChatMember
  new_chat_member: TgChatMember
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  edited_message?: TgMessage
  callback_query?: TgCallbackQuery
  my_chat_member?: TgChatMemberUpdated
}

export interface InlineButton {
  text: string
  callback_data?: string
  url?: string
}

export interface InlineKeyboard {
  inline_keyboard: InlineButton[][]
}

export interface SendOptions {
  reply_markup?: InlineKeyboard
  disable_link_preview?: boolean
  reply_to_message_id?: number
  /** Group posts that shouldn't ping members. */
  disable_notification?: boolean
}
