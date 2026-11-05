// Procedural materials from the approved interactive universe design.
export type CelestialKind = "star" | "planet" | "moon";
export type Appearance = {
  name: string;
  family: string;
  ring?: string;
  fallback?: string;
  model?: number;
  tone?: number[];
};
export type CelestialStyle = { surface: string; ring?: string };
export const families: Record<string, string> = {
  terrestrial: "类地地表",
  giant: "气态巨星",
  extreme: "冰封火山",
  fantasy: "发光晶体",
  main: "主序恒星",
  giants: "巨星",
  compact: "致密恒星",
  rock: "岩质卫星",
  ice: "冰质卫星",
  special: "特色卫星",
};
export function appearancesFor(kind: CelestialKind) {
  return kind === "star" ? starDefs : kind === "moon" ? moonDefs : typeDefs;
}
export function defaultSurface(kind: CelestialKind, seed: number) {
  const keys = Object.keys(appearancesFor(kind));
  return keys[Math.abs(seed) % keys.length];
}
export const typeDefs: Record<string, Appearance> = {
  gas: { name: "带环巨行星", family: "giant", ring: "broad" },
  ocean: { name: "海洋行星", family: "terrestrial" },
  crystal: { name: "晶体超地球", family: "extreme" },
  lava: { name: "熔岩行星", family: "extreme" },
  forest: { name: "翠绿行星", family: "terrestrial" },
  sand: { name: "沙漠行星", family: "terrestrial" },
  storm: { name: "风暴巨行星", family: "giant" },
  cloud: { name: "云海行星", family: "giant" },
  iron: { name: "金属行星", family: "terrestrial" },
  rock: { name: "陨坑行星", family: "terrestrial" },
  ice: { name: "带环冰巨星", family: "giant", ring: "icy" },
  frozen: { name: "冰封行星", family: "extreme" },
  obsidian: { name: "黑曜岩行星", family: "terrestrial" },
  marble: { name: "大理石行星", family: "terrestrial", fallback: "cloud" },
  copper: { name: "铜岩行星", family: "terrestrial", fallback: "iron" },
  salt: { name: "盐湖行星", family: "terrestrial", fallback: "frozen" },
  canyon: { name: "峡谷行星", family: "terrestrial", fallback: "sand" },
  ash: { name: "火山灰行星", family: "extreme", fallback: "rock" },
  sulfur: { name: "硫磺行星", family: "extreme", fallback: "sand" },
  rust: { name: "赤铁行星", family: "terrestrial", fallback: "rock" },
  moss: { name: "苔原行星", family: "terrestrial", fallback: "forest" },
  tropical: { name: "群岛行星", family: "terrestrial", fallback: "ocean" },
  tidal: { name: "潮汐行星", family: "extreme", fallback: "lava" },
  glacier: { name: "冰川裂谷星", family: "extreme", fallback: "frozen" },
  snow: { name: "雪原行星", family: "extreme", fallback: "frozen" },
  mint: { name: "薄荷冰巨星", family: "giant", fallback: "ice" },
  cobalt: { name: "钴蓝巨行星", family: "giant", fallback: "storm" },
  lavender: { name: "紫云巨行星", family: "giant", fallback: "gas" },
  pearl: { name: "珍珠云巨星", family: "giant", fallback: "cloud" },
  amber: { name: "琥珀巨行星", family: "giant", fallback: "gas", ring: "thin" },
  rose: { name: "玫瑰云巨星", family: "giant", fallback: "storm" },
  aurora: { name: "极光行星", family: "fantasy", fallback: "forest" },
  luminous: { name: "夜光海洋星", family: "fantasy", fallback: "ocean" },
  biolume: { name: "荧光森林星", family: "fantasy", fallback: "forest" },
  opal: { name: "欧泊晶体星", family: "fantasy", fallback: "crystal" },
  sapphire: { name: "蓝宝石晶体星", family: "fantasy", fallback: "crystal" },
};
export const starDefs: Record<string, Appearance> = {
  bluewhite: { name: "蓝白恒星", tone: [171, 207, 255], family: "main" },
  gold: { name: "金色恒星", tone: [255, 210, 145], family: "main" },
  red: { name: "红矮星", tone: [255, 123, 89], family: "main" },
  orange: { name: "橙矮星", tone: [255, 166, 99], family: "main" },
  redgiant: { name: "红巨星", tone: [255, 107, 75], family: "giants" },
  bluegiant: { name: "蓝巨星", tone: [127, 183, 255], family: "giants" },
  white: { name: "白矮星", tone: [233, 245, 255], family: "compact" },
  neutron: { name: "中子星", tone: [174, 216, 255], family: "compact" },
};
export const moonDefs: Record<string, Appearance> = {
  chalk: { name: "月岩卫星", family: "rock" },
  frost: { name: "霜冻卫星", family: "ice" },
  ochre: { name: "赭色卫星", family: "rock" },
  porcelain: { name: "瓷白卫星", family: "ice" },
  metal: { name: "金属卫星", family: "special" },
  basalt: { name: "玄武岩卫星", family: "rock" },
  crystal: { name: "晶簇卫星", family: "special" },
  volcanic: { name: "火山卫星", family: "special" },
};
Object.values(typeDefs).forEach((t, i) => {
  t.model = i < 13 ? i + 1 : i + 2;
});
export const ringDefs: Record<string, string> = {
  none: "无星环",
  thin: "纤细环",
  broad: "宽阔环",
  double: "双层环",
  icy: "冰晶环",
  broken: "碎片环",
};
export const vertex = `varying vec3 vLocal; varying vec3 vWorld; varying vec3 vNormal;
      void main(){vLocal=position;vec4 w=modelMatrix*vec4(position,1.);vWorld=w.xyz;vNormal=normalize(mat3(modelMatrix)*normal);gl_Position=projectionMatrix*viewMatrix*w;}`;
export const fragment = `precision highp float;
      varying vec3 vLocal;varying vec3 vWorld;varying vec3 vNormal;
      uniform int uKind;uniform int uVariant;uniform float uSeed;uniform float uTime;uniform float uSelected;uniform vec3 uStar;uniform vec3 uEye;uniform vec3 uTone;
      float hash(vec3 p){p=fract(p*.3183099+vec3(.1,.3,.7));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
      float noise3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
      vec3 srgb(vec3 c){c=max(c,vec3(0.));return mix(c*12.92,1.055*pow(c,vec3(1./2.4))-.055,step(vec3(.0031308),c));}
      float fbm(vec3 p){return noise3(p)*.55+noise3(p*2.03+7.)*.27+noise3(p*4.07+19.)*.13+noise3(p*8.11+31.)*.05;}
      void main(){vec3 p=normalize(vLocal),N=normalize(vNormal),V=normalize(uEye-vWorld);float lon=atan(p.x,p.z),lat=asin(clamp(p.y,-1.,1.)),n=fbm(p*4.+uSeed),fine=noise3(p*64.+uSeed),emission=0.,specular=.08;vec3 c=vec3(.3),emit=vec3(0.);
        if(uKind==0){float scale=uVariant>=6?57.:uVariant==4?15.:32.;float granules=fbm(p*scale+uSeed+uTime*.012);float radiance=.88+granules*.24;if(uVariant==4)radiance=.69+granules*.46;if(uVariant==5)radiance=.9+granules*.18;if(uVariant==6)radiance=.95+granules*.05;if(uVariant==7){float belt=exp(-pow(lat*9.,2.));radiance=.72+granules*.08+belt*.43;}c=uTone*radiance;c*=.74+.26*pow(max(0.,dot(N,V)),.3);gl_FragColor=vec4(srgb(c),1.);return;}
        if(uKind==1){float stripe=.5+.5*sin(lat*35.+noise3(p*7.)*2.);c=mix(vec3(.35,.26,.17),vec3(.82,.66,.43),stripe*.65+n*.35);float storm=exp(-pow((lon+.5)*3.,2.)-pow((lat-.13)*10.,2.));c=mix(c,vec3(.65,.29,.16),storm*.6);}
        else if(uKind==2){float land=smoothstep(.49,.54,n),polar=smoothstep(.83,.96,abs(p.y));c=mix(vec3(.035,.15,.31),mix(vec3(.10,.28,.20),vec3(.38,.43,.24),n),land);c=mix(c,vec3(.8,.88,.9),polar);float cloud=smoothstep(.59,.74,fbm(p*12.+vec3(uTime*.015,0,0)))*.8;c=mix(c,vec3(.91,.94,.97),cloud);specular=.24*(1.-land);}
        else if(uKind==3){float facet=.5+.5*sin(lon*15.+lat*19.+n*3.);c=mix(vec3(.2,.46,.65),vec3(.68,.9,1.),n*.7+facet*.25);specular=.6;}
        else if(uKind==4){float vein=abs(sin(lon*8.+lat*11.+n*13.));float aa=max(.012,fwidth(vein)*1.5);emission=(1.-smoothstep(.055,.105+aa,vein))*smoothstep(.31,.43,n);c=mix(vec3(.055,.038,.047),vec3(.18,.11,.10),n)+fine*.014;emit=mix(vec3(1.,.12,.012),vec3(1.,.55,.09),emission)*emission;}
        else if(uKind==5){c=mix(vec3(.06,.20,.15),vec3(.26,.48,.33),n);float cloud=smoothstep(.65,.8,fbm(p*15.));c=mix(c,vec3(.82,.9,.88),cloud*.7);}
        else if(uKind==6){float dunes=sin(lat*34.+lon*6.+n*5.)*.04;c=mix(vec3(.43,.23,.12),vec3(.85,.65,.39),n)+dunes;}
        else if(uKind==7){float stripe=.5+.5*sin(lat*30.+sin(lon*3.+lat*7.)*.8+n*3.);float storm=exp(-pow((lon+.5)*3.,2.)-pow((lat-.2)*8.,2.));c=mix(vec3(.31,.13,.12),vec3(.79,.49,.38),stripe*.5+n*.5);c=mix(c,vec3(.75,.25,.15),storm*.8);}
        else if(uKind==8){float clouds=fbm(p*9.+vec3(sin(lat*9.)*.2,0,0));c=mix(vec3(.35,.37,.52),vec3(.92,.9,.96),clouds);}
        else if(uKind==9){float bands=.5+.5*sin(lon*11.+lat*16.+n*6.);c=mix(vec3(.2,.26,.34),vec3(.55,.66,.75),n*.7+bands*.3);specular=.95;}
        else if(uKind==11){float bands=.5+.5*sin(lat*28.+n*3.);c=mix(vec3(.24,.5,.65),vec3(.64,.82,.9),n*.6+bands*.4);specular=.32;}
        else if(uKind==12){float fault=abs(sin(lon*7.-lat*13.+n*8.));float aa=max(.02,fwidth(fault));c=mix(vec3(.3,.57,.76),vec3(.78,.89,.94),smoothstep(.04,.12+aa,fault));c*=.9+n*.2;specular=.48;}
        else if(uKind==13){c=mix(vec3(.028,.035,.055),vec3(.16,.18,.27),n);specular=1.3;}
        else if(uKind==14){float crater=smoothstep(.66,.86,noise3(p*39.+uSeed));c=mix(vec3(.43,.47,.52),vec3(.76,.79,.84),clamp(n*1.3,0.,1.))-crater*.055+fine*.028;if(uVariant==1){float fault=abs(sin(lon*13.-lat*9.+n*6.));c=mix(vec3(.23,.46,.65),vec3(.78,.88,.94),smoothstep(.03,.13,fault));specular=.4;}else if(uVariant==2)c=mix(vec3(.5,.3,.15),vec3(.85,.68,.45),n)-crater*.09;else if(uVariant==3){c=mix(vec3(.65,.77,.73),vec3(.94,.95,.88),n);specular=.55;}else if(uVariant==4){c=mix(vec3(.31,.38,.47),vec3(.72,.77,.83),n+sin(lat*24.+n*6.)*.12);specular=.9;}else if(uVariant==5)c=mix(vec3(.19,.22,.27),vec3(.43,.46,.51),n)-crater*.06;else if(uVariant==6){float facet=floor((lon+lat)*16.)*.21;c=mix(vec3(.20,.49,.54),vec3(.64,.87,.85),fract(facet+n*.5));specular=.7;}else if(uVariant==7){float vein=1.-smoothstep(.05,.10+fwidth(n)*2.,abs(sin(lon*9.+n*17.+lat*7.)));c=mix(vec3(.34,.32,.31),vec3(.62,.59,.54),n);emit=vec3(.9,.22,.04)*vein*.55;}}
        else if(uKind==15){float veins=abs(sin(lon*5.+lat*4.+fbm(p*7.)*15.));c=mix(vec3(.16,.37,.33),vec3(.85,.89,.8),smoothstep(.02,.16+fwidth(veins),veins));c*=.9+n*.17;specular=.5;}
        else if(uKind==16){float patina=smoothstep(.47,.6,n);c=mix(vec3(.72,.33,.12),vec3(.11,.47,.41),patina);c+=sin(lat*17.+n*8.)*.025;specular=.7;}
        else if(uKind==17){float basin=smoothstep(.48,.53,n);c=mix(vec3(.49,.3,.34),vec3(.89,.86,.74),basin);float shore=exp(-pow((n-.5)*35.,2.));c=mix(c,vec3(.35,.66,.66),shore*.6);specular=.25*(1.-basin);}
        else if(uKind==18){float strata=.5+.5*sin(n*85.+lat*8.),rift=pow(1.-abs(sin(lon*3.+fbm(p*3.)*8.)),12.);c=mix(vec3(.37,.12,.07),vec3(.84,.49,.24),strata*.35+n*.65);c*=1.-rift*.55;}
        else if(uKind==19){float vent=pow(smoothstep(.57,.66,noise3(p*15.+uSeed)),7.);c=mix(vec3(.25,.27,.28),vec3(.55,.5,.44),n);emit=vec3(1.,.29,.015)*vent*.8;}
        else if(uKind==20){float sulfur=fbm(p*9.);c=mix(vec3(.42,.22,.04),vec3(.95,.77,.17),sulfur);float vent=smoothstep(.73,.81,noise3(p*19.));c=mix(c,vec3(.13,.08,.04),vent*.8);}
        else if(uKind==21){float basin=noise3(p*21.);c=mix(vec3(.33,.11,.07),vec3(.73,.37,.19),n*.8+basin*.2);c=mix(c,vec3(.76,.81,.78),smoothstep(.86,.98,abs(p.y)));}
        else if(uKind==22){float snow=smoothstep(.62,.79,abs(p.y)+n*.27);c=mix(vec3(.19,.26,.14),vec3(.46,.53,.3),n);c=mix(c,vec3(.79,.85,.82),snow);}
        else if(uKind==23){float islands=smoothstep(.56,.6,fbm(p*10.+uSeed)),shelf=smoothstep(.49,.56,fbm(p*10.+uSeed));c=mix(vec3(.025,.15,.34),vec3(.07,.52,.58),shelf);c=mix(c,vec3(.15,.48,.22),islands);float clouds=smoothstep(.69,.78,fbm(p*13.+2.));c=mix(c,vec3(.93),clouds*.7);specular=.3*(1.-islands);}
        else if(uKind==24){float hemisphere=smoothstep(-.13,.13,p.x+n*.23);vec3 cold=mix(vec3(.12,.33,.56),vec3(.72,.87,.94),n),hot=mix(vec3(.18,.04,.025),vec3(.68,.21,.045),n);c=mix(cold,hot,hemisphere);float border=exp(-pow((p.x+n*.23)*12.,2.));emit=vec3(.8,.29,.04)*border*.6;}
        else if(uKind==25){float crack=abs(sin(lon*6.-lat*9.+noise3(p*4.)*5.));float seam=1.-smoothstep(.025,.11+fwidth(crack),crack);c=mix(vec3(.32,.68,.84),vec3(.85,.93,.95),n);c=mix(c,vec3(.025,.18,.4),seam);specular=.55;}
        else if(uKind==26){float basin=smoothstep(.36,.54,n);c=mix(vec3(.26,.49,.64),vec3(.9,.93,.91),basin);c+=fine*.035;specular=.2;}
        else if(uKind==27){float band=.5+.5*sin(lat*17.+n*2.);c=mix(vec3(.20,.52,.49),vec3(.67,.88,.76),band*.55+n*.45);}
        else if(uKind==28){float wave=sin(lat*24.+sin(lon*4.+lat*5.)*.9+n*2.);float cyclone=exp(-pow((lon+.4)*2.6,2.)-pow((lat-.17)*8.,2.));c=mix(vec3(.035,.12,.39),vec3(.18,.45,.76),n*.7+wave*.15);c=mix(c,vec3(.74,.85,.95),cyclone*(.6+.4*sin(lon*20.+lat*29.)));}
        else if(uKind==29){float wave=.5+.5*sin(lat*19.+sin(lon*3.)*.8+n*4.);c=mix(vec3(.31,.18,.44),vec3(.76,.65,.87),wave*.65+n*.35);}
        else if(uKind==30){float cloud=fbm(p*11.+vec3(sin(lat*8.),0,0));c=mix(vec3(.54,.58,.62),vec3(.94,.88,.74),cloud);c=mix(c,vec3(.65,.74,.82),smoothstep(.63,.75,cloud)*.4);specular=.42;}
        else if(uKind==31){float bands=.5+.5*sin(lat*42.+n*3.),stripe=.5+.5*sin(lat*91.+n*4.);c=mix(vec3(.39,.17,.035),vec3(.93,.62,.20),bands*.6+n*.4);c+=stripe*.035;}
        else if(uKind==32){float swirl=fbm(p*7.+vec3(sin(lat*15.)*.65,0,0));c=mix(vec3(.42,.16,.27),vec3(.91,.64,.66),swirl);float belt=.5+.5*sin(lat*12.+n*5.);c=mix(c,vec3(.86,.76,.69),belt*.18);}
        else if(uKind==33){c=mix(vec3(.025,.12,.17),vec3(.17,.29,.26),n);float curtain=exp(-pow((abs(lat)-1.05-sin(lon*7.)*.05)*12.,2.))*(.5+.5*sin(lon*21.+n*5.));emit=mix(vec3(.05,.85,.39),vec3(.12,.48,1.),.5+.5*sin(lon*3.))*curtain*.8;}
        else if(uKind==34){float land=smoothstep(.49,.55,n),coast=exp(-pow((n-.51)*44.,2.));c=mix(vec3(.02,.09,.22),vec3(.13,.25,.24),land);emit=vec3(.04,.64,.92)*coast*(.3+.7*noise3(p*38.));specular=.3*(1.-land);}
        else if(uKind==35){float forest=fbm(p*13.);c=mix(vec3(.035,.13,.11),vec3(.13,.34,.23),n);float spores=smoothstep(.75,.86,noise3(p*72.));float vein=1.-smoothstep(.02,.05,abs(sin(lon*9.+n*21.)));emit=vec3(.12,.88,.57)*(spores*.7+vein*forest*.23);}
        else if(uKind==36){vec3 cell=floor(p*12.);float face=hash(cell);c=.42+.30*cos(vec3(0.,2.2,4.3)+face*8.+n*3.);c=mix(c,vec3(.79,.85,.87),.3);specular=.8;emit=c*.04;}
        else if(uKind==37){float facet=hash(floor(p*11.)),vein=1.-smoothstep(.02,.065+fwidth(n),abs(sin(lon*13.+lat*17.+n*6.)));c=mix(vec3(.025,.10,.35),vec3(.15,.48,.8),facet*.65+n*.35);c=mix(c,vec3(.44,.76,.94),vein*.7);specular=1.;}
        else{float crater=smoothstep(.65,.86,noise3(p*43.));c=mix(vec3(.19,.2,.23),vec3(.49,.5,.53),n)-crater*.12+fine*.025;}
        vec3 L=normalize(uStar-vWorld),H=normalize(L+V);float diffuse=max(0.,dot(N,L)),ambient=uKind==14?.23:.16,fill=(uKind==14?.13:.10)*(.3+.7*max(0.,dot(N,V))),fresnel=pow(1.-max(0.,dot(N,V)),3.5),shine=pow(max(0.,dot(N,H)),uKind==13?110.:48.)*specular;vec3 atmosphere=uKind==2?vec3(.13,.4,.82):uKind==5?vec3(.11,.3,.27):vec3(.22,.37,.5);vec3 color=c*(ambient+fill+.84*pow(diffuse,.82))+shine*diffuse+atmosphere*fresnel*(.08+.25*diffuse)+emit*.78;color+=vec3(.09,.14,.23)*uSelected*fresnel;float minimumLight=uKind==14?.12:.032;float lift=max(0.,minimumLight-dot(color,vec3(.2126,.7152,.0722)));color+=vec3(.9,.98,1.05)*lift;gl_FragColor=vec4(srgb(color),1.);}`;
export const ringFragment = `precision highp float;varying vec3 vLocal;varying vec3 vWorld;varying vec3 vNormal;uniform int uRingStyle;uniform float uCold;uniform vec3 uCenter;uniform vec3 uStar;uniform float uRadius;
      void main(){float r=length(vLocal.xy),a=atan(vLocal.y,vLocal.x),inner=1.39,outer=2.34;float bands=.35+.1*sin(r*115.)+.05*sin(r*233.);float gap=1.-.8*(1.-smoothstep(.01,.024,abs(r-1.94)));if(uRingStyle==1){inner=1.65;outer=1.83;gap=1.;bands=.5;}else if(uRingStyle==3){inner=1.36;outer=2.63;gap=smoothstep(.09,.14,abs(r-1.94));}else if(uRingStyle==4){inner=1.27;outer=2.5;bands=.43+.14*sin(r*150.);gap=1.-.8*(1.-smoothstep(.012,.035,abs(r-2.08)));}else if(uRingStyle==5){inner=1.5;outer=2.7;bands*=smoothstep(.24,.4,.5+.5*sin(a*23.+sin(a*7.)*4.+r*9.));gap=1.;}float edge=smoothstep(inner,inner+.035,r)*(1.-smoothstep(outer-.05,outer,r));vec3 dir=normalize(uStar-vWorld),oc=vWorld-uCenter;float t=-dot(oc,dir);float shadow=t>0.&&length(oc+dir*t)<uRadius?.31:1.;vec3 c=mix(vec3(.69,.57,.4),vec3(.62,.8,.9),uCold);gl_FragColor=vec4(pow(c*shadow,vec3(1./2.2)),edge*bands*gap);}`;
