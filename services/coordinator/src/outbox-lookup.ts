import {PrismaClient,Outbox} from '../generated/client';

/** Ordinary messages use their wire ID as the primary key. Recovery messages
 * may use a different durable idempotency key: search JSON in SQLite only for
 * that fallback, without loading and parsing the group's historical outbox. */
export async function outboxByWireId(db:PrismaClient,groupId:string,messageId:string,kind?:string):Promise<Outbox|null>{
 const direct=await db.outbox.findUnique({where:{id:messageId}});
 if(direct&&direct.groupId===groupId&&(!kind||direct.kind===kind)&&JSON.parse(direct.messageJson).messageId===messageId)return direct;
 const rows=await db.$queryRaw<Outbox[]>`SELECT * FROM "Outbox" WHERE "groupId"=${groupId}
  AND json_extract("messageJson", '$.messageId')=${messageId}
  AND (${kind??null} IS NULL OR "kind"=${kind??null}) LIMIT 2`;
 if(rows.length>1)throw Error('OUTBOX_WIRE_ID_AMBIGUOUS');
 return rows[0]??null;
}
