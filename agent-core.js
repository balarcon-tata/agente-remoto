(function(root,factory){const api=factory();if(typeof module!=='undefined'&&module.exports)module.exports=api;root.AgentCore=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
const DAYS=['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
const norm=s=>(s??'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const uniq=a=>[...new Set(a.filter(v=>v!==null&&v!==undefined&&v!=='').map(String))];
const num=v=>Number(v||0)||0; const fmt=n=>Number(n||0).toLocaleString('en-US',{maximumFractionDigits:1});
const dayName=d=>DAYS[new Date(d+'T12:00:00').getDay()];
function freshMemory(){return{area:null,line:null,date:null,order:null,style:null,operation:null,metric:null,target:null,groupBy:null,lastPlan:null,lastSelection:null};}
function catalogs(rows){return{lines:uniq(rows.map(r=>r.linea)),orders:uniq(rows.map(r=>r.orden)),styles:uniq(rows.map(r=>String(r.estilo))),operations:uniq(rows.flatMap(r=>(r.operaciones||[]).map(o=>o.operacion)))}}
function fuzzy(text,items,strip=false,minScore=.55){const n=norm(text);let best=null,score=0;for(const raw of items){let l=norm(raw);if(strip)l=l.replace(/^\d+\s+/,'');const parts=l.split(' ').filter(Boolean),meaningful=parts.filter(x=>x.length>2||/\d/.test(x));let sc=n.includes(l)?1:(meaningful.length?meaningful.filter(p=>new RegExp('(^|\\s)'+p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'($|\\s)').test(n)).length/meaningful.length:0);if(meaningful.some(p=>(p.length>5||/\d/.test(p))&&new RegExp('(^|\\s)'+p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'($|\\s)').test(n)))sc=Math.max(sc,.72);if(sc>score){score=sc;best=raw}}return score>=minScore?best:null}
function resolveLine(text,rows){
  const n=norm(text),lines=catalogs(rows).lines;
  const globalList=/\b(que|qué|cuales|cuáles|lista|listado|muestra|muestrame|muéstrame|dime)\b.*\b(lineas|líneas|familias)\b|\b(lineas|líneas|familias)\b.*\b(activas|programadas|hay|tienen|existen|semana)\b/.test(n);
  if(globalList)return{line:null,invalid:null};
  const info=lines.map(raw=>({raw,label:norm(raw).replace(/^\d+\s+/,''),tokens:norm(raw).replace(/^\d+\s+/,'').split(' ').filter(x=>x.length>2)}));
  const freq={};for(const x of info)for(const t of new Set(x.tokens))freq[t]=(freq[t]||0)+1;const generic=new Set(['atraque','modulo','linea','familia']);
  let best=null,bestScore=0;
  for(const x of info){const distinct=x.tokens.filter(t=>(freq[t]||0)===1&&!generic.has(t));let s=n.includes(x.label)?1:0;const hits=distinct.filter(t=>n.includes(t)).length;if(distinct.length&&hits)s=Math.max(s,.72+.08*(hits-1));if(s>bestScore){best=x.raw;bestScore=s}}
  if(bestScore>=.72)return{line:best,invalid:null};
  const lineWords=/\b(linea|lineas|familia|familias|automatico|manual|tornillo|metalico|webb|webbing|oculta|spg)\b/.test(n)||/\batraque\s+[a-z0-9]+/.test(n)||/\bmodulo\s+[a-z0-9]+/.test(n);
  if(lineWords){let m=n.match(/\b(?:linea|familia)\s+(?:de\s+)?([a-z0-9 ]{2,35})/);let requested=m?m[1].trim():null;if(!requested){m=n.match(/\b(atraque\s+[a-z0-9]+|modulo\s+[a-z0-9]+|automatico|manual|tornillo|metalico|webb|webbing|hebilla\s+oculta|spg)\b/);requested=m?m[1]:null}return{line:null,invalid:requested||'línea solicitada'};}
  return{line:null,invalid:null};
}
function mentionedDates(text,rows){
  const n=norm(text),dates=uniq(rows.map(r=>r.fecha)).sort(),hits=[];
  for(const d of dates){const dn=dayName(d),idx=n.indexOf(dn);if(idx>=0)hits.push({date:d,idx})}
  hits.sort((a,b)=>a.idx-b.idx);return hits.map(x=>x.date);
}
function explicit(text,rows){
  const c=catalogs(rows),n=norm(text),dates=mentionedDates(text,rows);let date=dates[0]||null;
  const iso=(text.match(/20\d\d-\d\d-\d\d/)||[])[0];if(iso){date=iso;if(!dates.includes(iso))dates.unshift(iso)}
  const order=((text.toUpperCase().match(/\bT\d{5,}\b/)||[])[0])||null;
  const nums=(text.match(/\b\d{5,6}\b/g)||[]).map(x=>String(Number(x)));const style=nums.find(x=>c.styles.includes(x))||null;
  const operation=fuzzy(text,c.operations,false,.58),lr=resolveLine(text,rows);
  return{line:lr.line,invalidLine:operation&&!lr.line&&!/\b(linea|familia|manual|automatico|tornillo|metalico|webb|webbing|oculta|spg)\b/.test(n)?null:lr.invalid,date,dates,order,style,operation}
}
function sanitize(p){p=p&&typeof p==='object'?p:{};const pick=(v,a,d)=>a.includes(v)?v:d;return{action:pick(p.action,['aggregate','rank','group','detail','count','compare','analyze','explain','relationship','clarify'],'clarify'),target:pick(p.target,['area','line','order','style','operation','day'],'area'),metric:pick(p.metric,['units','hc','sam','efficiency','count','date','multi'],'multi'),groupBy:pick(p.groupBy,['none','date','line','order','style','operation'],'none'),criterion:pick(p.criterion,['none','max','min'],'none'),filters:{line:p.filters?.line||null,date:p.filters?.date||null,order:p.filters?.order||null,style:p.filters?.style||null,operation:p.filters?.operation||null},output:pick(p.output,['brief','table','chart','analysis'],'brief')}}
function validateModelFilters(p,rows){
  const c=catalogs(rows);
  if(p.filters.line&&!c.lines.some(x=>norm(x)===norm(p.filters.line)))p.filters.line=null;
  if(p.filters.date&&!rows.some(r=>r.fecha===p.filters.date))p.filters.date=null;
  if(p.filters.order&&!c.orders.some(x=>norm(x)===norm(p.filters.order)))p.filters.order=null;
  if(p.filters.style&&!c.styles.includes(String(p.filters.style)))p.filters.style=null;
  if(p.filters.operation&&!c.operations.some(x=>norm(x)===norm(p.filters.operation)))p.filters.operation=null;
  return p;
}
function semantic(text,raw,memory,rows){
  const n=norm(text),e=explicit(text,rows); let p=sanitize(raw);
  // El modelo decide la OPERACION de consulta, pero nunca las entidades/filtros.
  // Los filtros solo pueden venir del texto, de datos reales o de memoria valida.
  p.filters={line:null,date:null,order:null,style:null,operation:null};
  p.invalidLine=e.invalidLine||null;

  const asksHC=/\b(hc|personal|personas|gente|recursos|headcount)\b/.test(n);
  const asksLoad=/\b(carga|cargado|cargada|presion|presión)\b/.test(n);
  const asksUnits=/\b(unidades|unidad|volumen|demanda|cantidad|programa|producir|planificad)\b/.test(n);
  const asksSAM=/\b(sam|complej|dificil|dificultad|tecnic)\b/.test(n);
  const asksEff=/\b(eficiencia|eficiente|ineficiente)\b/.test(n);
  const weeklyScope=/\b(semana|semanal|durante la semana|en la semana|toda la semana|semana completa)\b/.test(n);
  const behaviorQ=/\b(comportamiento|tendencia|evolucion|evolución|variacion|variación|como se comporta|cómo se comporta|como estan|cómo están)\b/.test(n);
  const lineRosterQ=/\b(que|qué|cuales|cuáles|lista|listado|muestra|muestrame|muéstrame|dime)\b.*\b(lineas|líneas|familias)\b.*\b(activas|programadas|unidades|semana|hay|tienen|existen)\b|\b(lineas|líneas|familias)\b.*\b(activas|programadas|unidades|semana|hay|tienen|existen)\b/.test(n);
  const globalLineQ=lineRosterQ||/\b(todas las lineas|todas las líneas|todas las familias|area completa|área completa|programa completo|general)\b/.test(n)||/\b(familia|familias|linea|línea|lineas|líneas)\b.*\b(mayor|menor|mas|más|compar|ranking|todas|cargada|cargado)\b/.test(n);
  const wantsByDay=/\b(por dia|por día|cada dia|cada día|dia por dia|día por día|despliegue por dia|despliegue por día|distribucion por dia|distribución por día)\b/.test(n);
  const wantsAllOperations=/\b(todas las operaciones|todas operaciones|lista de operaciones|listado de operaciones|desglose de operaciones|despliegue de operaciones|detalle de operaciones|que operaciones|qué operaciones|operaciones del|operaciones de|operaciones para|por operacion|por operación)\b/.test(n);
  const wantsAllOrders=/\b(todas las ordenes|todas las órdenes|lista de ordenes|lista de órdenes|listado de ordenes|listado de órdenes|por cada orden|por orden)\b/.test(n);
  const broadScopeQ=/\b(area completa|área completa|programa completo|total del area|total del área|general|todo troquel|todo ensamble|toda la linea|toda la línea)\b/.test(n);
  const followUpQ=/^(y\s+|ahora\s+|entonces\s+)?(dame|muestra|muestrame|muéstrame|quiero ver|despliega|despliegue|detalle|desglose|como|cómo|cuanto|cuánto|cuanta|cuánta|cuantas|cuántas|por dia|por día|solo|de eso|de esa|de ese)\b/.test(n)||wantsByDay||/\b(esa operacion|esa operación|dicha operacion|dicha operación|lo anterior|mismo alcance|ese mismo)\b/.test(n);

  if(asksUnits)p.metric='units'; else if(asksHC)p.metric='hc'; else if(asksSAM)p.metric='sam'; else if(asksEff)p.metric='efficiency'; else if(asksLoad)p.metric=memory.metric||'hc';
  if(/\b(menor|menos|minim|mas baja|más baja)\b/.test(n))p.criterion='min';
  if(/\b(mayor|mas|máximo|maximo|pico)\b/.test(n)&&p.criterion==='none')p.criterion='max';

  if(/\borden(es)?\b/.test(n))p.target='order';
  if(/\bestilo(s)?\b/.test(n))p.target='style';
  if(/\boperacion|operación|operaciones\b/.test(n))p.target='operation';
  if(/\bfamilia|familias|linea|línea|lineas|líneas\b/.test(n))p.target='line';

  const refOrder=/\b(esa orden|esta orden|la orden anterior|esa misma orden|dicha orden)\b/.test(n);
  const refStyle=/\b(ese estilo|este estilo|el estilo anterior|ese mismo estilo|dicho estilo)\b/.test(n);
  const refOp=/\b(esa operacion|esa operación|esta operacion|esta operación|la operacion anterior|la operación anterior|dicha operacion|dicha operación)\b/.test(n);
  const refDay=/\b(ese dia|ese día|este dia|este día|el mismo dia|el mismo día|dicho dia|dicho día)\b/.test(n);
  const comparesDays=(e.dates||[]).length>=2&&/\b(que|vs|versus|compar|diferencia|mayor|menor|mas|más|menos|porque|por que|por qué)\b/.test(n);

  // Entidades explicitas detectadas contra catalogos reales.
  for(const k of ['line','date','order','style','operation'])if(e[k])p.filters[k]=e[k];

  // Memoria conversacional jerárquica. Un seguimiento hereda el alcance previo salvo que el usuario lo amplíe explícitamente.
  if(!e.line&&!globalLineQ&&memory.line)p.filters.line=memory.line;
  if(!e.date&&!weeklyScope&&memory.date&&!globalLineQ)p.filters.date=memory.date;
  if(refOrder&&memory.order)p.filters.order=memory.order;
  if(refStyle&&memory.style)p.filters.style=memory.style;
  if(refOp&&memory.operation)p.filters.operation=memory.operation;
  if(refDay&&memory.date)p.filters.date=memory.date;

  // Seguimientos elípticos: "dame el despliegue por día", "y el HC", "muéstrame las órdenes".
  // Conservan operación/orden/estilo si no se pidió explícitamente abrir el alcance.
  if(followUpQ&&!broadScopeQ){
    if(!e.operation&&!wantsAllOperations&&memory.operation)p.filters.operation=memory.operation;
    if(!e.order&&!wantsAllOrders&&!p.filters.operation&&memory.order)p.filters.order=memory.order;
    if(!e.style&&!p.filters.operation&&!p.filters.order&&memory.style)p.filters.style=memory.style;
    if(!asksHC&&!asksUnits&&!asksSAM&&!asksEff&&memory.metric)p.metric=memory.metric;
  }
  if(broadScopeQ){p.filters.line=null;p.filters.date=null;p.filters.order=null;p.filters.style=null;p.filters.operation=null;}

  // Cambio explicito de linea abre un nuevo alcance: borra entidades hijas y, si no nombra dia, analiza la semana.
  if(e.line){
    p.filters.line=e.line;
    if(!e.date)p.filters.date=null;
    p.filters.order=null;p.filters.style=null;p.filters.operation=null;
  }
  if(globalLineQ){p.filters.line=null;p.invalidLine=null;}
  if(weeklyScope)p.filters.date=null;
  if(lineRosterQ){
    p.action='group';p.target='line';p.groupBy='line';p.metric='units';p.criterion='none';p.output='table';
    p.filters.line=null;p.filters.date=null;p.filters.order=null;p.filters.style=null;p.filters.operation=null;p.invalidLine=null;
    p.lineDailyMatrix=true;
  }
  if(comparesDays){
    p.action='compare';p.target='day';p.metric=asksHC?'hc':asksUnits?'units':(memory.metric||'hc');p.criterion='none';p.output='analysis';
    p.compareDates=e.dates.slice(0,2);p.filters.date=null;p.filters.order=null;p.filters.style=null;p.filters.operation=null;
    if(e.line)p.filters.line=e.line;else if(memory.line&&!globalLineQ)p.filters.line=memory.line;
  }

  // Referencias explicitas por orden completan el contexto desde los datos reales.
  if(e.order){const rr=rows.find(r=>norm(r.orden)===norm(e.order));if(rr){p.filters.order=e.order;p.filters.line=rr.linea;p.filters.date=rr.fecha;p.filters.style=String(rr.estilo)}}
  if(e.style){p.filters.style=e.style;p.filters.order=null;p.filters.operation=null;}

  // Tendencia/comportamiento semanal: siempre agrupa lunes-viernes y no arrastra filtros hijos.
  if((weeklyScope&&behaviorQ)||(/\btendencia\b/.test(n)&&!e.date)){
    p.action='group';p.groupBy='date';p.target='day';p.metric=asksHC?'hc':asksUnits?'units':(memory.metric||'units');p.criterion='none';p.output='chart';
    p.filters.date=null;p.filters.order=null;p.filters.style=null;p.filters.operation=null;
  }

  const wantsOpList=wantsAllOperations;
  if(wantsOpList){
    p.action='group';p.groupBy='operation';p.target='operation';p.metric=asksSAM?'sam':asksEff?'efficiency':'hc';p.criterion='none';p.output='table';p.filters.operation=null;
    if(refOrder&&memory.order)p.filters.order=memory.order;
    if((e.style||refStyle)&&memory.style)p.filters.style=e.style||memory.style;
    if(e.style||refStyle)p.filters.order=null;
  }

  // "por cada orden" y "por orden" son agrupaciones, aunque no diga listado/desglose.
  const wantsOrderList=/\b(listado|lista|desglose|desglosa|detalle|muestrame|muéstrame|quiero ver)\b.*\borden|\bordenes|\bórdenes|\bpor cada orden\b|\bpor orden\b|\bde cada orden\b|\bunidades por orden\b|\bhc por orden\b/.test(n);
  if(wantsOrderList&&!wantsOpList){p.action='group';p.groupBy='order';p.target='order';p.metric=asksHC?'hc':'units';p.criterion='none';p.output='table';p.filters.order=null;}

  const operationAssignmentQ=!!e.operation&&asksUnits&&/\b(asignad|asignada|asignadas|asignado|tiene|tienen|lleva|llevan|pasa|pasan|requiere|requieren|operacion|operación)\b/.test(n)&&!/(mayor|menor|maxim|minim|ranking|top)/.test(n);
  if(operationAssignmentQ){p.action='aggregate';p.target='operation';p.metric='units';p.criterion='none';p.output='brief';p.filters.operation=e.operation;}

  if(wantsByDay&&!wantsOpList&&!wantsOrderList){
    p.groupBy='date';p.action='group';p.target='day';p.output='chart';p.criterion='none';
    if(!asksHC&&!asksUnits&&!asksSAM&&!asksEff)p.metric=memory.metric||p.metric||'units';
    if(!p.filters.operation&&!e.operation&&memory.operation)p.filters.operation=memory.operation;
  }
  if(/\bcuantas familias|cuantas lineas|cuántas familias|cuántas líneas\b/.test(n)){p.action='count';p.target='line';p.metric='count';p.filters.line=null;}
  if(/\bcuantas ordenes|cuántas órdenes\b/.test(n)){p.action='count';p.target='order';p.metric='count';}
  if(/\bcuantos estilos|cuántos estilos\b/.test(n)){p.action='count';p.target='style';p.metric='count';}

  if(/\b(que dia|qué día|cuando esta|cuándo está|fecha)\b/.test(n)&&(/orden/.test(n)||memory.order)){p.action='detail';p.target='order';p.metric='date';p.output='brief';if(!p.filters.order&&memory.order)p.filters.order=memory.order;}
  if(/\b(es de|pertenece|corresponde a)\b/.test(n)&&(/orden/.test(n)||memory.order)){p.action='relationship';p.target='order';p.criterion='none';if(!p.filters.order&&memory.order)p.filters.order=memory.order;}

  if(!comparesDays&&/\b(porque|por que|por qué|explica|razon|razón)\b/.test(n)){p.action='explain';p.output='analysis';}
  if(!comparesDays&&/\b(analiza|analisis|análisis|recomienda|que harias|qué harías|prioridad|enfocarme|reforzar)\b/.test(n)){p.action='analyze';p.output='analysis';}
  if(/\b(operacion|operación)\b/.test(n)&&/\b(reforzar|refuerzo|personal|gente|cobertura|enfocarme|prioridad)\b/.test(n)){p.action='analyze';p.target='operation';p.metric='multi';p.criterion='none';p.output='analysis';}

  if(/operacion critica|operación crítica/.test(n)){p.target='operation';p.metric='hc';p.criterion='max';p.action='rank';}
  if(/operacion.*(complej|dificil)|operación.*(complej|difícil)/.test(n)){p.target='operation';p.metric='sam';p.criterion='max';p.action='rank';}
  if(p.target==='style'&&/\b(complej|dificil|dificultad)\b/.test(n)&&!wantsOpList){p.metric='sam';p.criterion='max';p.action='rank';}

  // Si la pregunta solo dice carga y no define criterio, conserva la métrica previa si existe;
  // si no existe, ambiguity() pedirá aclaración en vez de adivinar.
  if(asksLoad&&!asksHC&&!asksUnits&&!asksSAM&&!asksEff&&memory.metric)p.metric=memory.metric;

  if(comparesDays){
    p.action='compare';p.target='day';p.groupBy='none';p.criterion='none';p.output='analysis';p.compareDates=e.dates.slice(0,2);
    p.filters.date=null;p.filters.order=null;p.filters.style=null;p.filters.operation=null;if(e.line)p.filters.line=e.line;else if(memory.line&&!globalLineQ)p.filters.line=memory.line;
  }
  p=validateModelFilters(p,rows);
  if(p.action==='clarify'){if(p.criterion!=='none'&&p.target!=='area')p.action='rank';else if(p.groupBy!=='none')p.action='group';else if(p.metric!=='multi')p.action='aggregate';}
  if(['order','style','operation','line'].includes(p.target)&&p.criterion!=='none'&&!['analyze','explain'].includes(p.action)&&!wantsOpList&&!wantsOrderList)p.action='rank';
  if(p.metric==='multi'&&['aggregate','rank','group'].includes(p.action))p.metric='units';
  return p;
}
function ambiguity(text,p,memory,rows){
  const n=norm(text),c=catalogs(rows);
  const lineRosterQ=/\b(que|qué|cuales|cuáles|lista|listado|muestra|muestrame|muéstrame|dime)\b.*\b(lineas|líneas|familias)\b.*\b(activas|programadas|unidades|semana|hay|tienen|existen)\b|\b(lineas|líneas|familias)\b.*\b(activas|programadas|unidades|semana|hay|tienen|existen)\b/.test(n);
  if(lineRosterQ)return null;
  if(p.invalidLine){
    return{title:`No encuentro la línea "${p.invalidLine}" en esta semana.`,message:'Selecciona la línea que querías analizar:',choices:c.lines.map(x=>({label:x.replace(/^\d+\s*/,''),query:`En la línea ${x.replace(/^\d+\s*/,'')}: ${text}`}))};
  }
  const loadAmb=/\b(carga|cargado|cargada|pesada|pesado|complicada|complicado|critica|crítica)\b/.test(n)&&!(/\b(hc|personal|personas|unidades|volumen|demanda|sam|complejidad|eficiencia)\b/.test(n))&&!memory.metric;
  if(loadAmb&&!/\b(porque|por que|por qué|analiza|prioridad|recomienda)\b/.test(n)){
    return{title:'¿Con qué criterio quieres medirlo?',message:'Puedo interpretar esa pregunta de varias formas.',choices:[
      {label:'HC requerido',query:`Usando HC requerido: ${text}`},
      {label:'Unidades programadas',query:`Usando unidades programadas: ${text}`},
      {label:'Complejidad por SAM',query:`Usando SAM: ${text}`}
    ]};
  }
  const refDay=/\b(ese dia|ese día|este dia|este día|dicho dia|dicho día)\b/.test(n);
  if(refDay&&!memory.date){
    const dates=uniq(rows.map(r=>r.fecha)).sort();
    return{title:'No tengo un día activo en la conversación.',message:'Selecciona el día al que te refieres:',choices:dates.map(d=>({label:dayName(d),query:`Para el ${dayName(d)}: ${text.replace(/ese d[ií]a|este d[ií]a|dicho d[ií]a/ig,dayName(d))}`}))};
  }
  const refOrder=/\b(esa orden|esta orden|dicha orden)\b/.test(n);
  if(refOrder&&!memory.order){
    const scope=filterRows(rows,{line:memory.line,date:memory.date}),top=agg(scope.length?scope:rows,'order').sort((a,b)=>b.units-a.units).slice(0,5);
    return{title:'No hay una orden seleccionada todavía.',message:'¿Te refieres a alguna de estas órdenes del alcance actual?',choices:top.map(x=>({label:`${x.key} · ${fmt(x.units)} un.`,query:`Sobre la orden ${x.key}: ${text.replace(/esa orden|esta orden|dicha orden/ig,x.key)}`}))};
  }

  // Preguntas abiertas: no adivinar. Ofrecer acciones compatibles con el contexto activo.
  const genericOpen=/^(dame|muestra|muestrame|muéstrame|quiero ver|haz|hazme)?\s*(el |la |un |una )?(detalle|despliegue|desglose|resumen|analisis|análisis|informacion|información|que hay|qué hay|como esta|cómo está|revisa)(\s+(de|sobre)\s+(eso|esto|esa|ese))?\s*$/.test(n);
  const unresolved=(p.action==='clarify')||(p.target==='area'&&p.metric==='multi'&&p.groupBy==='none'&&p.criterion==='none');
  if(genericOpen||unresolved){
    const scopeName=memory.operation?`la operación ${memory.operation}`:memory.order?`la orden ${memory.order}`:memory.style?`el estilo ${memory.style}`:memory.line?`la línea ${memory.line.replace(/^\d+\s*/,'')}`:'el área activa';
    const prefix=memory.operation?`Para la operación ${memory.operation}`:memory.order?`Para la orden ${memory.order}`:memory.style?`Para el estilo ${memory.style}`:memory.line?`Para la línea ${memory.line.replace(/^\d+\s*/,'')}`:'';
    const choices=memory.operation?[
      {label:'Unidades por día',query:`${prefix}, muéstrame las unidades planificadas por día`},
      {label:'HC por día',query:`${prefix}, muéstrame el HC requerido por día`},
      {label:'Órdenes con esta operación',query:`${prefix}, dame las unidades por orden`},
      {label:'Todas las operaciones',query:'Dame el despliegue de todas las operaciones del área'}
    ]:[
      {label:'Unidades por día',query:`${prefix} muéstrame las unidades planificadas por día`.trim()},
      {label:'HC por día',query:`${prefix} muéstrame el HC requerido por día`.trim()},
      {label:'Operaciones por HC',query:`${prefix} dame el despliegue de operaciones por HC`.trim()},
      {label:'Órdenes por unidades',query:`${prefix} dame las unidades por orden`.trim()}
    ];
    return{title:`¿Qué quieres ver de ${scopeName}?`,message:'La pregunta admite varias interpretaciones. Elige una opción para conservar correctamente el contexto.',choices};
  }
  return null;
}
function filterRows(rows,f={}){return rows.filter(r=>(!f.line||norm(r.linea)===norm(f.line))&&(!f.date||r.fecha===f.date)&&(!f.order||norm(r.orden)===norm(f.order))&&(!f.style||String(r.estilo)===String(f.style))&&(!f.operation||(r.operaciones||[]).some(o=>norm(o.operacion)===norm(f.operation))))}
function flatOps(rows){return rows.flatMap(r=>(r.operaciones||[]).map(o=>({key:o.operacion,hc:num(o.hc),sam:num(o.sam),efficiency:num(o.eficiencia),units:num(r.unidades),date:r.fecha,line:r.linea,order:r.orden,style:String(r.estilo)})))}
function agg(rows,entity){const key={line:'linea',order:'orden',style:'estilo',day:'fecha'}[entity],m=new Map();for(const r of rows){const k=String(r[key]??'—'),x=m.get(k)||{key:k,units:0,hc:0,count:0,dates:new Set(),lines:new Set(),styles:new Set(),orders:new Set()};x.units+=num(r.unidades);x.hc+=num(r.hc);x.count++;x.dates.add(r.fecha);x.lines.add(r.linea);x.styles.add(String(r.estilo));x.orders.add(r.orden);m.set(k,x)}return[...m.values()].map(x=>({...x,dates:[...x.dates],lines:[...x.lines],styles:[...x.styles],orders:[...x.orders]}))}
function aggOps(rows){const m=new Map();for(const o of flatOps(rows)){const x=m.get(o.key)||{key:o.key,hc:0,units:0,sam:0,effNum:0,effDen:0,orders:new Set(),styles:new Set(),dates:new Set(),lines:new Set()};x.hc+=o.hc;x.units+=o.units;x.sam=Math.max(x.sam,o.sam);const w=Math.max(o.hc,.0001);x.effNum+=o.efficiency*w;x.effDen+=w;x.orders.add(o.order);x.styles.add(o.style);x.dates.add(o.date);x.lines.add(o.line);m.set(o.key,x)}return[...m.values()].map(x=>({...x,efficiency:x.effDen?x.effNum/x.effDen:0,orders:[...x.orders],styles:[...x.styles],dates:[...x.dates],lines:[...x.lines]}))}
function value(x,m){return m==='units'?num(x.units):m==='hc'?num(x.hc):m==='sam'?num(x.sam):m==='efficiency'?num(x.efficiency):m==='count'?num(x.count):0}
function selected(entity,x,rows){if(!x)return{};if(entity==='order'){const r=rows.find(z=>String(z.orden)===String(x.key))||{};return{order:x.key,line:r.linea||x.lines?.[0],date:r.fecha||x.dates?.[0],style:String(r.estilo||x.styles?.[0]||'')}}if(entity==='style')return{style:String(x.key),line:x.lines?.[0],date:x.dates?.[0]};if(entity==='line')return{line:x.key};if(entity==='operation')return{operation:x.key,line:x.lines?.[0],date:x.dates?.[0]};if(entity==='day')return{date:x.key};return{}}
function execute(rows,p,memory={}){const r={ok:true,plan:p,rows:[],selected:null,entity:null,data:null};if(p.invalidLine){r.ok=false;r.errorCode='INVALID_LINE';r.error=`La línea \"${p.invalidLine}\" no está programada en la semana cargada. Líneas disponibles: ${catalogs(rows).lines.map(x=>x.replace(/^\d+\s*/,'')).join(', ')}.`;return r}const rs=filterRows(rows,p.filters);r.rows=rs;if(!rs.length){r.ok=false;r.error='No hay registros para ese alcance.';return r}const m=p.metric==='multi'?'units':p.metric;
if(p.action==='relationship'){const order=p.filters.order||memory.order,rr=rows.filter(x=>norm(x.orden)===norm(order)),lines=uniq(rr.map(x=>x.linea)),target=p.filters.line||null;r.entity='order';r.selected={order,line:lines[0],date:rr[0]?.fecha,style:String(rr[0]?.estilo||'')};r.data={order,lines,targetLine:target,belongs:target?lines.some(l=>norm(l)===norm(target)):null};return r}
if(p.action==='detail'&&p.target==='order'){const order=p.filters.order||memory.order,rr=rows.filter(x=>norm(x.orden)===norm(order));if(!rr.length){r.ok=false;r.error='No encontré esa orden.';return r}r.entity='order';r.selected={order,line:rr[0].linea,date:rr[0].fecha,style:String(rr[0].estilo)};r.data={order,dates:uniq(rr.map(x=>x.fecha)),lines:uniq(rr.map(x=>x.linea)),styles:uniq(rr.map(x=>String(x.estilo))),units:rr.reduce((s,x)=>s+num(x.unidades),0),hc:rr.reduce((s,x)=>s+num(x.hc),0),operations:aggOps(rr).sort((a,b)=>b.hc-a.hc)};return r}
if(p.action==='count'){let vals=[];if(p.target==='line')vals=uniq(rs.map(x=>x.linea));if(p.target==='order')vals=uniq(rs.map(x=>x.orden));if(p.target==='style')vals=uniq(rs.map(x=>String(x.estilo)));if(p.target==='operation')vals=uniq(flatOps(rs).map(x=>x.key));if(p.target==='day')vals=uniq(rs.map(x=>x.fecha));r.entity=p.target;r.data={count:vals.length,values:vals};return r}
if(p.action==='aggregate'){r.entity=p.target;r.data={units:rs.reduce((s,x)=>s+num(x.unidades),0),hc:rs.reduce((s,x)=>s+num(x.hc),0),orders:uniq(rs.map(x=>x.orden)).length,styles:uniq(rs.map(x=>String(x.estilo))).length,lines:uniq(rs.map(x=>x.linea)).length};return r}
if(p.action==='group'){const e=p.groupBy==='date'?'day':p.groupBy,d=p.groupBy==='operation'?aggOps(rs):agg(rs,e);if(p.groupBy==='date')d.sort((a,b)=>String(a.key).localeCompare(String(b.key)));else d.sort((a,b)=>value(b,m)-value(a,m));r.entity=e;r.data=d;return r}
if(p.action==='rank'){const e=p.target,d=e==='operation'?aggOps(rs):agg(rs,e),sg=p.criterion==='min'?1:-1;d.sort((a,b)=>sg*(value(a,m)-value(b,m)));r.entity=e;r.data=d;r.selected=selected(e,d[0],rs);return r}
if(['analyze','explain','compare'].includes(p.action)){const byLine=agg(rs,'line').sort((a,b)=>b.hc-a.hc),byOrderU=agg(rs,'order').sort((a,b)=>b.units-a.units),byOrderH=agg(rs,'order').sort((a,b)=>b.hc-a.hc),byStyle=agg(rs,'style').sort((a,b)=>b.units-a.units),ops=aggOps(rs),opH=[...ops].sort((a,b)=>b.hc-a.hc),opS=[...ops].sort((a,b)=>b.sam-a.sam),days=agg(rs,'day').sort((a,b)=>a.key.localeCompare(b.key));r.data={units:rs.reduce((s,x)=>s+num(x.unidades),0),hc:rs.reduce((s,x)=>s+num(x.hc),0),lineCount:uniq(rs.map(x=>x.linea)).length,orderCount:uniq(rs.map(x=>x.orden)).length,styleCount:uniq(rs.map(x=>String(x.estilo))).length,topLines:byLine.slice(0,5),topOrderUnits:byOrderU[0],topOrderHC:byOrderH[0],topStyleUnits:byStyle[0],topOperationHC:opH[0],topOperationSAM:opS[0],days};return r}
r.ok=false;r.error='El plan no pudo ejecutarse.';return r}
function update(memory,p,r){
  const m={...freshMemory(),...(memory||{})};
  if(r?.errorCode==='INVALID_LINE'){m.line=null;m.order=null;m.style=null;m.operation=null;if(p.filters?.date)m.date=p.filters.date;m.metric=p.metric&&p.metric!=='multi'?p.metric:m.metric;m.lastPlan=p;return m;}
  // Cambio de alcance: limpia entidades más específicas para evitar contaminación.
  if(p.target==='line'&&p.filters?.line&&norm(p.filters.line)!==norm(m.line||'')){m.order=null;m.style=null;m.operation=null;}
  if(p.target==='style'&&(p.filters?.style||r?.selected?.style)){m.order=null;m.operation=null;}
  if(p.target==='order'&&(p.filters?.order||r?.selected?.order)){m.operation=null;}
  if(p.action==='group'&&p.groupBy==='operation'){m.operation=null;if(p.filters?.style&&!p.filters?.order)m.order=null;}
  if(p.action==='group'&&p.groupBy==='order')m.order=null;
  for(const k of ['line','date','order','style','operation'])if(p.filters?.[k])m[k]=p.filters[k];
  if(p.compareDates&&p.compareDates.length)m.date=p.compareDates[0];
  if(p.metric&&p.metric!=='multi')m.metric=p.metric;
  if(p.target)m.target=p.target;
  if(p.groupBy&&p.groupBy!=='none')m.groupBy=p.groupBy;
  if(r?.selected)for(const k of ['line','date','order','style','operation'])if(r.selected[k])m[k]=r.selected[k];
  if(r?.entity)m.lastSelection={entity:r.entity,value:r.selected?.[r.entity]||null};
  m.lastPlan=p;return m;
}
function plannerPrompt(q,memory,rows){return `Eres el PLANIFICADOR de Sócrates, agente de ingeniería del área activa indicada en memoria. Usa exclusivamente los datos del área activa y no asumas Ensamble si se seleccionó otra área. NO respondas. Devuelve SOLO JSON valido. Datos: fecha,linea/familia,orden,estilo,unidades,hc,operaciones[{operacion,sam,eficiencia,hc}]. Lineas: ${catalogs(rows).lines.join(' | ')}. Memoria: ${JSON.stringify(memory)}. Pregunta: ${q}. Reglas: demanda/volumen/cantidad/programa=units; personal/gente/HC/recursos=hc; carga/cargado sin unidades explicitas=hc; operacion critica=mayor hc; operacion compleja/dificil=mayor sam; familia=linea; referencias y preguntas de seguimiento heredan memoria de operación/orden/estilo/métrica; 'despliegue por día' conserva el alcance previo y agrupa date; 'despliegue de operaciones' significa todas las operaciones y agrupa operation; unidades asignadas a una operacion=filtrar esa operacion y sumar units; por dia con operacion=group date manteniendo filtro de operacion; que dia esta una orden=detail order date; por que/analiza=reasons. No inventes lineas: usa solo las Lineas listadas. Schema: {"action":"aggregate|rank|group|detail|count|compare|analyze|explain|relationship|clarify","target":"area|line|order|style|operation|day","metric":"units|hc|sam|efficiency|count|date|multi","groupBy":"none|date|line|order|style|operation","criterion":"none|max|min","filters":{"line":null,"date":null,"order":null,"style":null,"operation":null},"output":"brief|table|chart|analysis"}`}
return{DAYS,norm,uniq,num,fmt,dayName,mentionedDates,freshMemory,catalogs,resolveLine,explicit,sanitize,semantic,ambiguity,filterRows,flatOps,agg,aggOps,value,execute,update,plannerPrompt};
});
