#include <cassert>
#include <random>
#include "../../../apps/harmony/scheduler/src/main/cpp/visual_match.hpp"
int main(){
 std::mt19937 rng(17321);
 for(int n=0;n<10000;n++){
  harmony_visual::Descriptor a,b;uint32_t exact=0;
  for(int k=0;k<128;k++){a.values[k]=rng()%256;b.values[k]=rng()%256;int d=int(a.values[k])-int(b.values[k]);exact+=d*d;}
  for(uint32_t bound:{0u,1u,exact/4,exact/2,exact,exact+1,UINT32_MAX}){
   auto value=harmony_visual::distanceSquared(a,b,bound);
   assert(exact<bound?value==exact:value>=bound);
  }
  assert(harmony_visual::distanceSquared(a,b)==exact);
 }
}
