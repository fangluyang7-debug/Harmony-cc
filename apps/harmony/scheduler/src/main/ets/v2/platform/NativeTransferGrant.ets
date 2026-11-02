import { ArtifactRefV2 } from '../protocol/SchedulingProtocolV2';
export interface NativeDataEndpoint {
 id:string;groupId:string;holderInstanceId:string;deviceId:string;epoch:string;address:string;certificate:string;fingerprint:string;
}
export interface NativeTransferAuthorization {
 version:number;id:string;domain:string;coordinatorEpoch:number;networkEpoch:string;workflowId:string;attemptId:string;appInstanceId:string;groupId:string;ownerPrincipalId:string;
 requesterHolderId:string;senderHolderId:string;receiverHolderId:string;endpoint:NativeDataEndpoint;ref:ArtifactRefV2;bytes:number;operation:string;
 proofHash:string;issuedAt:number;expiresAt:number;
}
export interface NativeSignedTransfer {authorization:NativeTransferAuthorization;signature:string;}
export interface NativeTransferGrant {signed:NativeSignedTransfer;proof:string;}
