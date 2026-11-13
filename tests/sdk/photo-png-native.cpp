#include "photo-png.h"
#include <string>
#include <iostream>
int main(int argc,char**argv){if(argc!=2)return 2;const std::string prefix=argv[1];
 for(auto dimensions:std::vector<std::pair<int,int>>{{5,3},{1024,777}}){int w=dimensions.first,h=dimensions.second;std::string name=prefix+"/"+std::to_string(w);FILE*f=fopen((name+".rgb").c_str(),"wb");if(!f)return 3;for(int y=0;y<h;y++)for(int x=0;x<w;x++){unsigned char b[]={static_cast<unsigned char>(x+y),static_cast<unsigned char>(x*3),static_cast<unsigned char>(y*7)};fwrite(b,1,3,f);}fclose(f);photoEncodeRgb((name+".rgb").c_str(),(name+".png").c_str(),w,h);}
 bool rejected=false;try{photoEncodeRgb((prefix+"/5.rgb").c_str(),(prefix+"/bad.png").c_str(),6,3);}catch(const std::exception&){rejected=true;}return rejected?0:4;
}
