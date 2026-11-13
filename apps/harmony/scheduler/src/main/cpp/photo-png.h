#pragma once
#include <cstdio>
#include <cstdint>
#include <stdexcept>
#include <vector>
#include <zlib.h>
// Row-streamed PNG: memory is proportional to output width, not full image area.
inline void photoPngWrite(FILE* f,const void* p,size_t n){if(fwrite(p,1,n,f)!=n)throw std::runtime_error("PHOTO_DISK_WRITE_FAILED");}
inline void photoPngU32(FILE* f,uint32_t n){uint8_t b[]={uint8_t(n>>24),uint8_t(n>>16),uint8_t(n>>8),uint8_t(n)};photoPngWrite(f,b,4);}
inline void photoPngChunk(FILE* f,const char* kind,const uint8_t* p,uint32_t n){photoPngU32(f,n);photoPngWrite(f,kind,4);if(n)photoPngWrite(f,p,n);uLong crc=crc32(0,reinterpret_cast<const Bytef*>(kind),4);if(n)crc=crc32(crc,p,n);photoPngU32(f,crc);}
inline void photoEncodeRgb(const char* source,const char* dest,uint32_t width,uint32_t height){
 if(!width||!height||width>131072||height>131072)throw std::runtime_error("PHOTO_GEOMETRY_INVALID");
 FILE* in=fopen(source,"rb");if(!in)throw std::runtime_error("PHOTO_RAW_MISSING");FILE* out=nullptr;z_stream z{};bool initialized=false;
 try{
  if(fseeko(in,0,SEEK_END)||ftello(in)!=int64_t(width)*height*3||fseeko(in,0,SEEK_SET))throw std::runtime_error("PHOTO_RAW_INCOMPLETE");
  out=fopen(dest,"wb");if(!out)throw std::runtime_error("PHOTO_DISK_WRITE_FAILED");const uint8_t sig[]={137,80,78,71,13,10,26,10};photoPngWrite(out,sig,8);
  uint8_t header[]={uint8_t(width>>24),uint8_t(width>>16),uint8_t(width>>8),uint8_t(width),uint8_t(height>>24),uint8_t(height>>16),uint8_t(height>>8),uint8_t(height),8,2,0,0,0};photoPngChunk(out,"IHDR",header,13);
  if(deflateInit(&z,3)!=Z_OK)throw std::runtime_error("PHOTO_PNG_INIT");initialized=true;
  std::vector<uint8_t> raw(size_t(width)*3),row(raw.size()+1),buffer(65536);row[0]=1;
  for(uint32_t y=0;y<height;y++){
   if(fread(raw.data(),1,raw.size(),in)!=raw.size())throw std::runtime_error("PHOTO_RAW_INCOMPLETE");
   for(size_t x=0;x<raw.size();x++)row[x+1]=uint8_t(raw[x]-(x>=3?raw[x-3]:0));
   z.next_in=row.data();z.avail_in=static_cast<uInt>(row.size());
   do{z.next_out=buffer.data();z.avail_out=buffer.size();if(deflate(&z,Z_NO_FLUSH)!=Z_OK)throw std::runtime_error("PHOTO_PNG_ENCODE");photoPngChunk(out,"IDAT",buffer.data(),buffer.size()-z.avail_out);}while(z.avail_in);
  }
  int status;do{z.next_out=buffer.data();z.avail_out=buffer.size();status=deflate(&z,Z_FINISH);if(status!=Z_OK&&status!=Z_STREAM_END)throw std::runtime_error("PHOTO_PNG_ENCODE");photoPngChunk(out,"IDAT",buffer.data(),buffer.size()-z.avail_out);}while(status!=Z_STREAM_END);
  deflateEnd(&z);initialized=false;photoPngChunk(out,"IEND",nullptr,0);if(fflush(out))throw std::runtime_error("PHOTO_DISK_WRITE_FAILED");fclose(out);out=nullptr;fclose(in);
 }catch(...){if(initialized)deflateEnd(&z);if(out)fclose(out);fclose(in);remove(dest);throw;}
}
