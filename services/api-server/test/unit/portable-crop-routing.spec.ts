import { StandardQueryImageContentAdapterService } from '../../src/modules/sessions/application/standard-query-image-content-adapter.service';
import { RuntimeWorkScope } from '../../src/core/runtime/runtime-work-scope';
import { DeviceDispatchService } from '../../src/core/runtime/device-dispatch.service';
import { PhoneDispatchService } from '../../src/modules/runtime/phone-dispatch.service';

describe('business adapter forwards task authorization into generic dispatch',()=>{
  const input={signedUrl:'https://storage.example/image',box:{x:0,y:0,width:1,height:1},paddingRatio:0,targetSize:64,jpegQuality:80};
  it.each([false,true])('only exposes remote candidates when transfer was explicitly authorized: %s',async allowed=>{
    const dispatch={dispatch:jest.fn().mockResolvedValue({buffer:Buffer.from('result')})};
    const phone={cropAdapters:jest.fn().mockResolvedValue([]),cropForShopping:jest.fn()};
    const adapter=new StandardQueryImageContentAdapterService(dispatch as unknown as DeviceDispatchService,phone as unknown as PhoneDispatchService);
    jest.spyOn(adapter as any,'fetchImageBuffer').mockResolvedValue(Buffer.from('image'));
    await RuntimeWorkScope.run(new AbortController().signal,{storageReadMs:0,storageWriteMs:0,modelMs:0},()=>adapter.cropForEmbedding(input),
      'owner',5000,{userWaiting:true,importance:1,networkAllowed:allowed,privacyLevel:allowed?'AUTHORIZED_REMOTE':'LOCAL_ONLY'});
    expect(dispatch.dispatch.mock.calls[0][1]).toMatchObject({networkAllowed:allowed,privacyLevel:allowed?'AUTHORIZED_REMOTE':'LOCAL_ONLY'});
    expect(phone.cropAdapters).toHaveBeenCalledTimes(allowed?1:0);
    expect(phone.cropForShopping).not.toHaveBeenCalled();
  });
});
