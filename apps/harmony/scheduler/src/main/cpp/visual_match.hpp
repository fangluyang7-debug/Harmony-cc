#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <functional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#include <zlib.h>
#if defined(__ARM_NEON) || defined(__aarch64__)
#include <arm_neon.h>
#elif defined(__SSE2__)
#include <emmintrin.h>
#endif

// Shared CPU kernel, compiled unchanged for Windows and HarmonyOS.
// Dense local gradient descriptors, exhaustive nearest-two matching and RGB
// agreement. This is an appearance index, not a semantic/SKU identity classifier.
namespace harmony_visual {
struct Image {std::string id;uint32_t w,h;std::vector<uint8_t> rgb;};
struct Reader {
 const uint8_t* p;size_t n,pos=0;
 uint32_t u32(){if(pos+4>n)throw std::runtime_error("VISUAL_INVALID");uint32_t v=uint32_t(p[pos])|uint32_t(p[pos+1])<<8|uint32_t(p[pos+2])<<16|uint32_t(p[pos+3])<<24;pos+=4;return v;}
 Image image(){Image im;auto len=u32();if(len<1||len>100||pos+len>n)throw std::runtime_error("VISUAL_INVALID");im.id.assign(reinterpret_cast<const char*>(p+pos),len);pos+=len;
  for(auto c:im.id)if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_'||c=='-'||c=='.'))throw std::runtime_error("VISUAL_INVALID");
  im.w=u32();im.h=u32();if(im.w<32||im.h<32||im.w>512||im.h>512||pos+size_t(im.w)*im.h*3>n)throw std::runtime_error("VISUAL_INVALID");
  im.rgb.assign(p+pos,p+pos+im.w*im.h*3);pos+=im.rgb.size();return im;}
};
struct Descriptor {std::array<uint8_t,128> values;};
// Squared terms are nonnegative. Once the partial distance cannot improve
// either direction's second-best match, the remaining dimensions are irrelevant.
inline uint32_t distanceSquared(const Descriptor& a,const Descriptor& b,uint32_t bound=UINT32_MAX){
#if defined(__ARM_NEON) || defined(__aarch64__)
 int32x4_t sum=vdupq_n_s32(0);
 for(int k=0;k<128;k+=16){const auto x=vld1q_u8(a.values.data()+k),y=vld1q_u8(b.values.data()+k);
  const auto lo=vreinterpretq_s16_u16(vsubl_u8(vget_low_u8(x),vget_low_u8(y))),hi=vreinterpretq_s16_u16(vsubl_u8(vget_high_u8(x),vget_high_u8(y)));
  sum=vmlal_s16(sum,vget_low_s16(lo),vget_low_s16(lo));sum=vmlal_s16(sum,vget_high_s16(lo),vget_high_s16(lo));
  sum=vmlal_s16(sum,vget_low_s16(hi),vget_low_s16(hi));sum=vmlal_s16(sum,vget_high_s16(hi),vget_high_s16(hi));
  if(k==48){uint32_t partial[4];vst1q_u32(partial,vreinterpretq_u32_s32(sum));if(partial[0]+partial[1]+partial[2]+partial[3]>=bound)return bound;}
 }uint32_t values[4];vst1q_u32(values,vreinterpretq_u32_s32(sum));return values[0]+values[1]+values[2]+values[3];
#elif defined(__SSE2__)
 auto sum=_mm_setzero_si128();const auto zero=_mm_setzero_si128();
 for(int k=0;k<128;k+=16){const auto x=_mm_loadu_si128(reinterpret_cast<const __m128i*>(a.values.data()+k)),y=_mm_loadu_si128(reinterpret_cast<const __m128i*>(b.values.data()+k));
  const auto lo=_mm_sub_epi16(_mm_unpacklo_epi8(x,zero),_mm_unpacklo_epi8(y,zero)),hi=_mm_sub_epi16(_mm_unpackhi_epi8(x,zero),_mm_unpackhi_epi8(y,zero));
  sum=_mm_add_epi32(sum,_mm_add_epi32(_mm_madd_epi16(lo,lo),_mm_madd_epi16(hi,hi)));
  if(k==48){uint32_t partial[4];_mm_storeu_si128(reinterpret_cast<__m128i*>(partial),sum);if(partial[0]+partial[1]+partial[2]+partial[3]>=bound)return bound;}
 }uint32_t values[4];_mm_storeu_si128(reinterpret_cast<__m128i*>(values),sum);return values[0]+values[1]+values[2]+values[3];
#else
 uint32_t sum=0;for(int k=0;k<128;k++){const int d=int(a.values[k])-int(b.values[k]);sum+=d*d;if(k==63&&sum>=bound)return bound;}return sum;
#endif
}
struct Features {std::vector<Descriptor> descriptors;std::array<uint32_t,3> color{};};
inline uint64_t isqrt(uint64_t n){auto r=uint64_t(std::sqrt(double(n)));while((r+1)*(r+1)<=n)++r;while(r*r>n)--r;return r;}
inline Features extract(const Image& im,const std::function<bool()>& cancelled){
 const int w=im.w,h=im.h;std::vector<int> grey(w*h),mag(w*h),orientation(w*h);Features result;
 std::array<uint64_t,3> sums{};uint64_t colored=0;
 for(int i=0;i<w*h;i++){const int r=im.rgb[i*3],g=im.rgb[i*3+1],b=im.rgb[i*3+2];grey[i]=(77*r+150*g+29*b+128)>>8;
  if(std::min({r,g,b})<235){for(int c=0;c<3;c++)sums[c]+=im.rgb[i*3+c];++colored;}}
 for(int c=0;c<3;c++)result.color[c]=colored?uint32_t(sums[c]/colored):255;
 for(int y=1;y<h-1;y++)for(int x=1;x<w-1;x++){const int i=y*w+x,gx=grey[i+1]-grey[i-1],gy=grey[i+w]-grey[i-w],ax=std::abs(gx),ay=std::abs(gy);mag[i]=ax+ay;
  orientation[i]=gy>=0?(gx>=0?(ax>=ay?0:1):(ay>=ax?2:3)):(gx<0?(ax>=ay?4:5):(ay>=ax?6:7));}
 // Integral orientation histograms compute the exact same cell sums without
 // scanning overlapping pixels again for every window and spatial scale.
 const size_t pitch=w+1,plane=pitch*(h+1);std::vector<uint32_t> integral(plane*8);
 for(int bin=0;bin<8;bin++)for(int y=0;y<h;y++){uint32_t row=0;for(int x=0;x<w;x++){const int i=y*w+x;if(orientation[i]==bin)row+=mag[i];integral[bin*plane+(y+1)*pitch+x+1]=integral[bin*plane+y*pitch+x+1]+row;}}
 // Two actual spatial scales; no repeat loops or synthetic workload multiplier.
 for(const int side:{32,64}){if(w<side||h<side)continue;const int cell=side/4;
  for(int y=0;y+side<=h;y+=8){if(cancelled())throw std::runtime_error("CANCELLED_SETTLED");
   for(int x=0;x+side<=w;x+=8){std::array<uint32_t,128> bins{};uint64_t energy=0;
    for(int cy=0;cy<4;cy++)for(int cx=0;cx<4;cx++)for(int bin=0;bin<8;bin++){
     const size_t x0=x+cx*cell,y0=y+cy*cell,x1=x0+cell,y1=y0+cell,base=bin*plane;
     const uint32_t value=integral[base+y1*pitch+x1]+integral[base+y0*pitch+x0]-integral[base+y0*pitch+x1]-integral[base+y1*pitch+x0];bins[(cy*4+cx)*8+bin]=value;energy+=value;
    }
    if(energy<uint64_t(side*side)*4)continue;uint64_t square=0;for(auto v:bins)square+=uint64_t(v)*v;const auto norm=isqrt(square);if(!norm)continue;Descriptor d;
    for(int k=0;k<128;k++)d.values[k]=uint8_t(std::min<uint64_t>(255,(uint64_t(bins[k])*512+norm/2)/norm));result.descriptors.push_back(d);
   }
  }
 }
 return result;
}
inline std::string runGraph(const uint8_t* data,size_t length,const std::function<bool()>& cancelled){
 if(length<12||length>8388608)throw std::runtime_error("VISUAL_INVALID");Reader outer{data,length,4};const auto rawLength=outer.u32();if(rawLength<16||rawLength>33554432)throw std::runtime_error("VISUAL_INVALID");
 std::vector<uint8_t> raw(rawLength);uLongf size=rawLength;if(uncompress(raw.data(),&size,data+8,length-8)!=Z_OK||size!=rawLength)throw std::runtime_error("VISUAL_INVALID");
 Reader r{raw.data(),raw.size()};const auto count=r.u32(),pairCount=r.u32();if(count<2||count>32||pairCount<1||pairCount>128)throw std::runtime_error("VISUAL_INVALID");
 std::vector<Image> images;for(uint32_t i=0;i<count;i++){auto im=r.image();for(const auto& old:images)if(old.id==im.id)throw std::runtime_error("VISUAL_INVALID");images.push_back(std::move(im));}
 std::vector<std::pair<uint32_t,uint32_t>> pairs;for(uint32_t i=0;i<pairCount;i++){auto a=r.u32(),b=r.u32();if(a>=b||b>=count||std::find(pairs.begin(),pairs.end(),std::make_pair(a,b))!=pairs.end())throw std::runtime_error("VISUAL_INVALID");pairs.emplace_back(a,b);}if(r.pos!=r.n)throw std::runtime_error("VISUAL_INVALID");
 std::vector<Features> features;for(const auto& image:images)features.push_back(extract(image,cancelled));std::ostringstream out;out<<"{\"algorithm\":\"dense-hog-rgb-graph-v1\",\"pairs\":[";bool first=true;
 for(const auto& pair:pairs){const auto& a=features[pair.first];const auto& b=features[pair.second];uint64_t sumA=0,sumB=0,distinct=0;
  std::vector<uint32_t> bestB(b.descriptors.size(),UINT32_MAX),secondB(b.descriptors.size(),UINT32_MAX);
  for(const auto& q:a.descriptors){if(cancelled())throw std::runtime_error("CANCELLED_SETTLED");uint32_t best=UINT32_MAX,second=UINT32_MAX;size_t j=0;
   for(const auto& c:b.descriptors){const uint32_t distance=distanceSquared(q,c,std::max(second,secondB[j]));
    if(distance<best){second=best;best=distance;}else if(distance<second)second=distance;
    if(distance<bestB[j]){secondB[j]=bestB[j];bestB[j]=distance;}else if(distance<secondB[j])secondB[j]=distance;++j;
   }
   sumA+=std::min<uint32_t>(524288,best);if(b.descriptors.size()>1&&uint64_t(best)*100<uint64_t(second)*64)++distinct;
  }
  for(size_t j=0;j<bestB.size();j++){sumB+=std::min<uint32_t>(524288,bestB[j]);if(a.descriptors.size()>1&&uint64_t(bestB[j])*100<uint64_t(secondB[j])*64)++distinct;}
  const uint64_t texture=a.descriptors.empty()||b.descriptors.empty()?0:1000000-(sumA*1000000/a.descriptors.size()+sumB*1000000/b.descriptors.size())/1048576;
  uint32_t colorDistance=0;for(int c=0;c<3;c++)colorDistance+=std::abs(int(a.color[c])-int(b.color[c]));const uint64_t color=1000000-uint64_t(colorDistance)*1000000/765;
  if(!first)out<<",";first=false;out<<"{\"a\":\""<<images[pair.first].id<<"\",\"b\":\""<<images[pair.second].id<<"\",\"scoreMillion\":"<<(texture?(texture*7+color*3)/10:0)<<",\"textureMillion\":"<<texture<<",\"colorMillion\":"<<color<<",\"featuresA\":"<<a.descriptors.size()<<",\"featuresB\":"<<b.descriptors.size()<<",\"comparisons\":"<<uint64_t(a.descriptors.size())*b.descriptors.size()<<",\"distinctMatches\":"<<distinct<<"}";
 }
 out<<"]}";return out.str();
}
inline std::string run(const uint8_t* data,size_t length,const std::function<bool()>& cancelled){
 if(length>=4&&data[0]=='H'&&data[1]=='V'&&data[2]=='G'&&data[3]=='1')return runGraph(data,length,cancelled);
 throw std::runtime_error("VISUAL_INVALID");
}
}
