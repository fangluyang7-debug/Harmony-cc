/** Invalidation hints only: clients re-read the authorized snapshot after reconnect. */
export class SpaceEvents {
  private readonly listeners=new Map<string,Set<()=>void>>();
  subscribe(spaceId:string,listener:()=>void){
    const group=this.listeners.get(spaceId)??new Set<()=>void>();
    group.add(listener);this.listeners.set(spaceId,group);
    return ()=>{group.delete(listener);if(!group.size)this.listeners.delete(spaceId);};
  }
  changed(spaceId:string){for(const listener of this.listeners.get(spaceId)??[])listener();}
}
