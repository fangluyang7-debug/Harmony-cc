const {test}=require('node:test'),assert=require('node:assert/strict');
test('member join keys preserve coordinator, code and fingerprint; raw codes remain scoped to the current console',async()=>{
 const {parseJoinKey}=await import('../../apps/team-space-web/join-key.mjs'),code='a'.repeat(24),pin='b'.repeat(64);
 assert.deepEqual(parseJoinKey('https://192.168.1.10:7443/#join='+code+'&pin='+pin),{address:'https://192.168.1.10:7443',code,fingerprint:pin});
 assert.equal(parseJoinKey(code,'https://local:7443').address,'https://local:7443');
 for(const text of ['12345678','1234 5678',' 1234-5678 '])assert.deepEqual(parseJoinKey(text,'https://local:7443'),{address:'https://local:7443',code:'12345678',fingerprint:''});
 assert.throws(()=>parseJoinKey('12345678'),/首次连接/);
 for(const value of ['1234567','123456789','1234abcd'])assert.throws(()=>parseJoinKey(value,'https://local:7443'));
 for(const value of ['http://host/#join='+code,'https://user@host/#join='+code,'https://host/path#join='+code,'https://host/#join='+code+'&pin=no','no','https://host/#join=short'])assert.throws(()=>parseJoinKey(value));
});
