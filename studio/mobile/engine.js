// The mobile pipeline edits rendered sRGB pixels. It does not develop RAW data.
export const DEFAULTS = Object.freeze({exposure:0,contrast:0,highlights:0,shadows:0,whites:0,blacks:0,
  temperature:0,tint:0,vibrance:0,saturation:0,grain:0,vignette:0,
  rotation:0,quarter_turns:0,crop:[0,0,1,1],curve:[[0,0],[1,1]],hsl:{},masks:[],look:'source',lut_amount:100,lut_id:null});
export const LOOKS = {
  source:{name:'Source color',note:'Just as you saw it',colors:['#a1af88','#d5d5b0','#3f5848']},
  meadow:{name:'Meadow',note:'Soft greens. Warm light.',colors:['#a7ad71','#e0c8a2','#597b58'],contrast:-8,temperature:8,vibrance:12,blacks:6},
  chrome:{name:'Quiet Chrome',note:'Muted color. Deep shadows.',colors:['#8ca1a2','#c8c3ad','#425257'],saturation:-22,contrast:15,shadows:-8,temperature:3},
  gold:{name:'Golden Hour',note:'A little more afternoon.',colors:['#b79054','#edcc8e','#7c6a49'],temperature:22,tint:4,contrast:5,highlights:-18},
  mono:{name:'Silver Mono',note:'Light, shape, and silver.',colors:['#9c9e94','#d8d9d0','#434840'],saturation:-100,contrast:18,blacks:-8}
};
export const HUES={red:0,orange:30,yellow:60,green:120,aqua:180,blue:240,purple:280,magenta:320};
export const LIMITS={exposure:[-5,5],contrast:[-100,100],highlights:[-100,100],shadows:[-100,100],whites:[-100,100],blacks:[-100,100],temperature:[-100,100],tint:[-100,100],vibrance:[-100,100],saturation:[-100,100],grain:[0,100],vignette:[-100,100],rotation:[-45,45],lut_amount:[0,100]};
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
function num(v,a,b){if(typeof v!=='number'||!Number.isFinite(v)||v<a||v>b)throw new Error(`Adjustment must be between ${a} and ${b}`);return v;}
export function validate(input={}){
  const e=structuredClone(DEFAULTS);
  for(const[k,[lo,hi]]of Object.entries(LIMITS))e[k]=num(input[k]??e[k],lo,hi);
  e.look=input.look??'source';if(!LOOKS[e.look])throw new Error('Unknown creative look');
  e.quarter_turns=num(input.quarter_turns??0,0,3);if(!Number.isInteger(e.quarter_turns))throw new Error('Invalid rotation');
  const crop=input.crop??e.crop;if(!Array.isArray(crop)||crop.length!==4)throw new Error('Invalid crop');
  e.crop=crop.map(v=>num(v,0,1));const[x,y,w,h]=e.crop;
  if(w<.01||h<.01||x+w>1.000001||y+h>1.000001)throw new Error('Crop must stay inside the photograph');
  const curve=input.curve??e.curve;
  if(!Array.isArray(curve)||curve.length<2||curve.length>12)throw new Error('Curve needs 2–12 points');
  e.curve=curve.map(p=>{if(!Array.isArray(p)||p.length!==2)throw new Error('Invalid curve point');return p.map(v=>num(v,0,1));});
  if(e.curve[0][0]!==0||e.curve.at(-1)[0]!==1||e.curve.some((p,i)=>i&&p[0]<=e.curve[i-1][0]))throw new Error('Curve points must increase from 0 to 1');
  for(const[k,v]of Object.entries(input.hsl||{})){
    if(!(k in HUES))throw new Error('Unknown color channel');
    e.hsl[k]={hue:num(v.hue??0,-100,100),saturation:num(v.saturation??0,-100,100),luminance:num(v.luminance??0,-100,100)};
  }
  if(!Array.isArray(input.masks??[])||(input.masks??[]).length>8)throw new Error('Up to eight local masks are supported');
  e.masks=(input.masks??[]).map(m=>{
    if(!['radial','linear'].includes(m.type))throw new Error('Invalid mask');
    return{type:m.type,x:num(m.x??.5,0,1),y:num(m.y??.5,0,1),radius:num(m.radius??.4,.02,2),feather:num(m.feather??.7,.01,1),angle:num(m.angle??90,-180,180),invert:!!m.invert,exposure:num(m.exposure??0,-3,3),temperature:num(m.temperature??0,-100,100),saturation:num(m.saturation??0,-100,100)};
  });
  e.lut_id=typeof input.lut_id==='string'?input.lut_id:null;
  return e;
}

export function geometry(width,height,input,maxEdge=0){
  const e=validate(input),odd=e.quarter_turns%2;
  const rw=odd?height:width,rh=odd?width:height;
  const[x,y,w,h]=e.crop,cx=Math.min(rw-1,Math.round(x*rw)),cy=Math.min(rh-1,Math.round(y*rh));
  const cw=Math.max(1,Math.min(rw,Math.round((x+w)*rw))-cx),ch=Math.max(1,Math.min(rh,Math.round((y+h)*rh))-cy);
  const scale=maxEdge?Math.min(1,maxEdge/Math.max(cw,ch)):1;
  return{width:Math.max(1,Math.round(cw*scale)),height:Math.max(1,Math.round(ch*scale)),cropX:cx,cropY:cy,cropW:cw,cropH:ch,rotW:rw,rotH:rh,scale,sourceW:width,sourceH:height,angle:(e.quarter_turns*90+e.rotation)*Math.PI/180};
}

const INPUT_LINEAR=Float32Array.from({length:256},(_,i)=>{const v=i/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});
const OUTPUT_SRGB=Float32Array.from({length:16385},(_,i)=>{const v=i/16384;return v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055;});
function srgb(v){if(v<=0)return 0;if(v>1)return 1.055*v**(1/2.4)-.055;const p=v*16384,i=Math.floor(p);return OUTPUT_SRGB[i]+(OUTPUT_SRGB[Math.min(i+1,16384)]-OUTPUT_SRGB[i])*(p-i);}
function saturation(rgb,amount){const l=.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];return rgb.map(v=>l+(v-l)*amount);}
function hsl(rgb){const[r,g,b]=rgb,mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn,l=(mx+mn)/2;let h=0;if(d){h=mx===r?((g-b)/d+6)%6:mx===g?(b-r)/d+2:(r-g)/d+4;}return[h/6,d/Math.max(1-Math.abs(2*l-1),1e-6),l];}
function fromHsl(h,s,l){const a=s*Math.min(l,1-l);return[0,8,4].map(n=>{const k=(n+h*12)%12;return l-a*Math.max(-1,Math.min(k-3,9-k,1));});}
function maskWeight(x,y,m){const dx=x-m.x,dy=y-m.y;let w=m.type==='radial'?clamp((1-Math.hypot(dx,dy)/m.radius)/m.feather):clamp(.5+(dx*Math.cos(m.angle*Math.PI/180)+dy*Math.sin(m.angle*Math.PI/180))/(m.radius*m.feather));return m.invert?1-w:w;}
function curveTable(points){const table=new Float32Array(4097);let k=0;for(let i=0;i<=4096;i++){const x=i/4096;while(k<points.length-2&&x>points[k+1][0])k++;const[a,b]=[points[k],points[k+1]];table[i]=a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]);}return table;}

export function processPixels(pixels,width,height,input,{offsetY=0,fullWidth=width,fullHeight=height,lut=null}={}){
  const e=validate(input),look=LOOKS[e.look],v={};for(const k of Object.keys(LIMITS))v[k]=e[k]+(look[k]||0);
  const gain=2**v.exposure,t=v.temperature/100,ti=v.tint/100;
  const gains=[gain*2**(.45*t+.18*ti),gain*2**(-.18*ti),gain*2**(-.45*t+.18*ti)];
  const masks=e.masks.map(m=>({...m,gains:[2**(m.exposure+.45*m.temperature/100),2**m.exposure,2**(m.exposure-.45*m.temperature/100)]}));
  const channels=Object.entries(e.hsl).filter(([,c])=>c.hue||c.saturation||c.luminance);
  const curve=e.curve.length!==2||e.curve[0][1]!==0||e.curve[1][1]!==1?curveTable(e.curve):null;
  for(let y=0;y<height;y++){
    const ny=(y+offsetY)/Math.max(1,fullHeight-1);
    for(let x=0;x<width;x++){
      const nx=x/Math.max(1,fullWidth-1),p=(y*width+x)*4;
      let rgb=[INPUT_LINEAR[pixels[p]]*gains[0],INPUT_LINEAR[pixels[p+1]]*gains[1],INPUT_LINEAR[pixels[p+2]]*gains[2]];
      for(const m of masks){const w=maskWeight(nx,ny,m);for(let c=0;c<3;c++)rgb[c]*=1+w*(m.gains[c]-1);}
      rgb=rgb.map(srgb);let lum=.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
      const shadow=clamp(1-lum)**2,high=clamp(lum)**2;
      const delta=(v.shadows*shadow+v.highlights*high)/400+v.blacks/350*shadow**2+v.whites/350*high**2;
      rgb=rgb.map(a=>Math.max(0,(a+delta-.5)*(1+v.contrast/140)+.5));
      const chroma=Math.max(...rgb)-Math.min(...rgb),sat=Math.max(0,1+v.saturation/100)*(1+v.vibrance/100*(1-clamp(chroma)));
      rgb=saturation(rgb,sat);
      for(const m of masks)if(m.saturation)rgb=saturation(rgb,1+maskWeight(nx,ny,m)*m.saturation/100);
      if(channels.length){let[h,s,l]=hsl(rgb.map(a=>clamp(a)));const base=h*360,baseS=s;
        for(const[name,c]of channels){const distance=Math.abs(((base-HUES[name]+540)%360)-180),w=clamp(1-distance/45)**2*clamp(baseS/.2);h+=w*c.hue/1200;s*=1+w*c.saturation/100;l+=w*c.luminance/400;}
        rgb=fromHsl((h+1)%1,clamp(s),clamp(l));
      }
      if(curve)rgb=rgb.map(a=>curve[Math.round(clamp(a)*4096)]);
      if(lut&&e.lut_id){const transformed=sampleLut(rgb,lut);rgb=rgb.map((a,c)=>a+(transformed[c]-a)*e.lut_amount/100);}
      if(v.vignette){const amount=1-v.vignette/180*clamp(((nx*2-1)**2+(ny*2-1)**2)/2);rgb=rgb.map(a=>a*amount);}
      if(v.grain){let hash=Math.imul(x+1,374761393)^Math.imul(y+offsetY+1,668265263);hash=Math.imul(hash^(hash>>>13),1274126177);const noise=((hash>>>0)/4294967295-.5)*v.grain/1800;rgb=rgb.map(a=>a+noise);}
      for(let c=0;c<3;c++)pixels[p+c]=Math.round(clamp(rgb[c])*255);pixels[p+3]=255;
    }
  }
  return pixels;
}

export function parseCube(text){let size,lo=[0,0,0],hi=[1,1,1],rows=[];
  for(const raw of text.split(/\r?\n/)){const p=raw.split('#')[0].trim().split(/\s+/);if(!p[0]||p[0]==='TITLE')continue;
    if(p[0]==='LUT_3D_SIZE'){size=Number(p[1]);if(!Number.isInteger(size)||size<2||size>65)throw new Error('3D LUT size must be 2–65');}
    else if(p[0]==='DOMAIN_MIN')lo=p.slice(1).map(Number);else if(p[0]==='DOMAIN_MAX')hi=p.slice(1).map(Number);
    else if(p[0].startsWith('LUT_'))throw new Error('Choose a 3D .cube LUT');
    else{if(p.length!==3)throw new Error('Invalid LUT row');rows.push(...p.map(Number));}
  }
  if(!size||rows.length!==size**3*3||[...rows,...lo,...hi].some(v=>!Number.isFinite(v))||lo.length!==3||hi.length!==3||hi.some((v,i)=>v<=lo[i]))throw new Error('Incomplete or invalid 3D LUT');
  return{size,lo,hi,table:new Float32Array(rows)};
}
function sampleLut(rgb,lut){const{size:n,lo,hi,table}=lut,p=rgb.map((a,c)=>clamp((a-lo[c])/(hi[c]-lo[c]))*(n-1)),low=p.map(Math.floor),frac=p.map((a,c)=>a-low[c]),out=[0,0,0];
  for(let b=0;b<2;b++)for(let g=0;g<2;g++)for(let r=0;r<2;r++){const bits=[r,g,b],indices=low.map((a,c)=>Math.min(a+bits[c],n-1));let weight=1;for(let c=0;c<3;c++)weight*=bits[c]?frac[c]:1-frac[c];const offset=((indices[2]*n+indices[1])*n+indices[0])*3;for(let c=0;c<3;c++)out[c]+=table[offset+c]*weight;}
  return out;
}

export function histogram(pixels){const channels=Array.from({length:3},()=>Array(64).fill(0));let black=0,white=0,count=0;for(let p=0;p<pixels.length;p+=16){for(let c=0;c<3;c++)channels[c][pixels[p+c]>>2]++;black+=Math.min(pixels[p],pixels[p+1],pixels[p+2])<=1;white+=Math.max(pixels[p],pixels[p+1],pixels[p+2])>=254;count++;}return{channels,black:black/Math.max(1,count),white:white/Math.max(1,count)};}

export function rafPreviewRange(header,fileSize){
  const bytes=new Uint8Array(header);if(bytes.length<92||new TextDecoder().decode(bytes.subarray(0,15))!=='FUJIFILMCCD-RAW '){
    // Some RAF versions pad the signature with a null instead of a space.
    if(bytes.length<92||!new TextDecoder().decode(bytes.subarray(0,16)).startsWith('FUJIFILMCCD-RAW'))throw new Error('This file has no readable Fujifilm RAF header');
  }
  const view=new DataView(header),offset=view.getUint32(84,false),length=view.getUint32(88,false);
  if(offset<92||length<4||offset+length>fileSize)throw new Error('The RAF embedded preview is missing or incomplete');
  return{offset,length};
}

let crcTable;
export function crc32(bytes){if(!crcTable)crcTable=Uint32Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
export function pngChunk(type,data){const out=new Uint8Array(data.length+12),view=new DataView(out.buffer);view.setUint32(0,data.length);out.set(new TextEncoder().encode(type),4);out.set(data,8);view.setUint32(data.length+8,crc32(out.subarray(4,data.length+8)));return out;}
export async function bandedPng(width,height,getBand,onProgress=()=>{}){
  if(typeof CompressionStream!=='function')throw new Error('Full-resolution PNG needs a newer browser. Choose JPEG at 2048 px instead.');
  const head=new Uint8Array(13),v=new DataView(head.buffer);v.setUint32(0,width);v.setUint32(4,height);head[8]=8;head[9]=6;
  const compressor=new CompressionStream('deflate'),writer=compressor.writable.getWriter(),reader=compressor.readable.getReader(),parts=[];
  const drain=(async()=>{for(;;){const{value,done}=await reader.read();if(done)break;parts.push(pngChunk('IDAT',value));}})();drain.catch(()=>{});
  try{for(let y=0;y<height;y+=96){const rows=Math.min(96,height-y),pixels=await getBand(y,rows);if(pixels.length!==width*rows*4)throw new Error('Incomplete image band');const stride=width*4,filtered=new Uint8Array((stride+1)*rows);for(let r=0;r<rows;r++)filtered.set(pixels.subarray(r*stride,(r+1)*stride),r*(stride+1)+1);await writer.write(filtered);onProgress((y+rows)/height);await new Promise(r=>setTimeout(r,0));}await writer.close();await drain;
    return new Blob([new Uint8Array([137,80,78,71,13,10,26,10]),pngChunk('IHDR',head),pngChunk('sRGB',new Uint8Array([0])),...parts,pngChunk('IEND',new Uint8Array())],{type:'image/png'});
  }catch(error){await writer.abort(error).catch(()=>{});await drain.catch(()=>{});throw error;}
}
