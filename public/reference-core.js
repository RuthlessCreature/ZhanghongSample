const uniq=xs=>[...new Set((xs||[]).filter(Boolean))];
const norm=v=>String(v??"").replace(/\s+/g," ").trim();
const upper=v=>norm(v).toUpperCase();

export function tokenizeReference(text=""){
  const t=String(text||""),out=[];
  out.push(...(upper(t).match(/[A-Z0-9]+(?:[-_.][A-Z0-9]+)*/g)||[]).filter(x=>x.length>=2));
  const zh=t.match(/[\u3400-\u9fff]{2,}/g)||[];
  for(const chunk of zh){
    if(chunk.length<=6)out.push(chunk);
    for(let n=2;n<=Math.min(5,chunk.length);n++){
      for(let i=0;i<=chunk.length-n;i++)out.push(chunk.slice(i,i+n));
    }
  }
  return uniq(out);
}

const SYNONYMS=[
  ["楼梯净宽","STAIR CLEAR WIDTH"],["净宽","CLEAR WIDTH"],["疏散宽度","EGRESS WIDTH"],
  ["无障碍","ACCESSIBLE"],["无障碍卫生间","ACCESSIBLE TOILET"],["回转直径","TURNING DIAMETER"],
  ["屋顶花园","ROOF GARDEN"],["防水上翻","WATERPROOF UPTURN"],["防水层","WATERPROOF MEMBRANE"],
  ["门窗表","DOOR WINDOW SCHEDULE"],["门窗编号","DOOR WINDOW MARK"],["图号","SHEET NUMBER"],
  ["未闭环","UNRESOLVED"],["待确认","VERIFY TBD CHECK"],["机房","SERVER ROOM"],["会议室","MEETING ROOM"],
  ["净高","CLEAR HEIGHT"],["栏杆","RAILING"],["女儿墙","PARAPET"],["坡道","RAMP"]
];

function expandTokens(query,tokens){
  const q=upper(query),out=[...(tokens||[])];
  for(const [zh,en] of SYNONYMS){
    if(q.includes(upper(zh))||q.includes(upper(en)))out.push(...tokenizeReference(zh),...tokenizeReference(en));
  }
  return uniq(out);
}

export function detectClauseNumber(text=""){
  const s=norm(text);
  const patterns=[
    /(?:^|\s)(\d{1,2}(?:\.\d{1,3}){1,4})(?=\s|[、:：.)]|$)/,
    /(?:第\s*)?(\d{1,3})\s*条/,
    /(?:CLAUSE|SECTION)\s+(\d{1,2}(?:\.\d{1,3}){0,4})/i
  ];
  for(const re of patterns){
    const m=s.match(re);if(m)return m[1];
  }
  return null;
}

export function parseReferenceQuery(query=""){
  const q=norm(query);
  const clauseRefs=uniq((q.match(/\b\d{1,2}(?:\.\d{1,3}){1,4}\b/g)||[]));
  const numbers=uniq((q.match(/[-+]?\d+(?:\.\d+)?/g)||[]).map(Number).filter(Number.isFinite));
  const base=tokenizeReference(q);
  return {raw:q,clauseRefs,numbers,tokens:expandTokens(q,base)};
}

function headingLike(text=""){
  const s=norm(text);
  return s.length<=80 && (/^(?:第?\s*)?\d{1,2}(?:\.\d{1,3}){0,3}\s+/.test(s)||/^[A-Z][A-Z\s/&-]{4,}$/.test(s));
}

export function chunkReferencePages(pages=[],meta={}){
  const chunks=[];let seq=1;
  for(const page of pages||[]){
    const pageNo=Number(page.pageNumber||1);
    const rawLines=(page.lines||String(page.text||"").split(/\r?\n+/)).map(norm).filter(Boolean);
    let current=null;
    const push=()=>{
      if(!current||!current.text.trim())return;
      current.text=norm(current.text);
      current.tokens=tokenizeReference(current.text+" "+current.title+" "+current.clause);
      chunks.push(current);current=null;
    };
    for(const line of rawLines){
      const clause=detectClauseNumber(line);
      if(clause){
        push();
        current={
          id:"E"+String(seq++).padStart(4,"0"),
          libraryId:String(meta.libraryId||""),
          documentId:String(meta.documentId||""),
          documentName:String(meta.documentName||"document.pdf"),
          documentType:String(meta.documentType||"reference"),
          version:String(meta.version||""),
          pageNumber:pageNo,
          clause,
          title:line,
          text:line
        };
        continue;
      }
      if(!current){
        current={
          id:"E"+String(seq++).padStart(4,"0"),
          libraryId:String(meta.libraryId||""),
          documentId:String(meta.documentId||""),
          documentName:String(meta.documentName||"document.pdf"),
          documentType:String(meta.documentType||"reference"),
          version:String(meta.version||""),
          pageNumber:pageNo,
          clause:null,
          title:headingLike(line)?line:"",
          text:line
        };
      }else{
        if(headingLike(line)&&current.text.length>500){
          push();
          current={
            id:"E"+String(seq++).padStart(4,"0"),
            libraryId:String(meta.libraryId||""),
            documentId:String(meta.documentId||""),
            documentName:String(meta.documentName||"document.pdf"),
            documentType:String(meta.documentType||"reference"),
            version:String(meta.version||""),
            pageNumber:pageNo,
            clause:null,title:line,text:line
          };
        }else current.text+=" "+line;
      }
    }
    push();
  }
  return chunks;
}

function overlapCount(a=[],b=[]){const s=new Set(b);return a.filter(x=>s.has(x)).length;}

function scoreChunk(parsed,chunk,filters={}){
  if(filters.documentId&&chunk.documentId!==filters.documentId)return -1;
  if(filters.documentType&&filters.documentType!=="all"&&chunk.documentType!==filters.documentType)return -1;
  let score=0;
  const clause=String(chunk.clause||""),txt=upper(chunk.text),title=upper(chunk.title||""),doc=upper(chunk.documentName||"");
  for(const ref of parsed.clauseRefs){
    if(clause===ref)score+=80;
    else if(clause.startsWith(ref+".")||ref.startsWith(clause+".")){score+=25;}
    else if(txt.includes(ref))score+=15;
  }
  if(parsed.raw&&txt.includes(upper(parsed.raw)))score+=25;
  const overlap=overlapCount(parsed.tokens,chunk.tokens||[]);
  score+=Math.min(42,overlap*2.4);
  for(const tok of parsed.tokens){
    if(tok.length<2)continue;
    if(title.includes(tok))score+=4;
    if(doc.includes(tok))score+=1.5;
  }
  for(const n of parsed.numbers){
    if(String(chunk.text).includes(String(n)))score+=2;
  }
  if(chunk.clause)score+=1;
  return score;
}

export function makeEvidenceSnippet(text="",parsed,maxLen=360){
  const s=norm(text);if(!s)return "";
  const needles=[...(parsed?.clauseRefs||[]),...(parsed?.tokens||[])].filter(x=>String(x).length>=2);
  const u=upper(s);let pos=-1;
  for(const n of needles){const p=u.indexOf(upper(n));if(p>=0&&(pos<0||p<pos))pos=p;}
  if(pos<0)return s.slice(0,maxLen)+(s.length>maxLen?"…":"");
  const start=Math.max(0,pos-Math.floor(maxLen*.3)),end=Math.min(s.length,start+maxLen);
  return (start?"…":"")+s.slice(start,end)+(end<s.length?"…":"");
}

export function searchReference(chunks=[],query="",filters={},limit=30){
  const parsed=parseReferenceQuery(query);
  if(!parsed.raw)return [];
  return (chunks||[]).map(c=>({...c,score:Number(scoreChunk(parsed,c,filters).toFixed(2)),snippet:makeEvidenceSnippet(c.text,parsed)}))
    .filter(x=>x.score>0)
    .sort((a,b)=>b.score-a.score||Number(a.pageNumber)-Number(b.pageNumber))
    .slice(0,limit);
}

export function summarizeReferenceLibrary(chunks=[]){
  const docs=new Set(),clauses=new Set(),types={};
  for(const c of chunks||[]){
    docs.add(c.documentId||c.documentName);
    if(c.clause)clauses.add((c.documentId||c.documentName)+"|"+c.clause);
    types[c.documentType]=(types[c.documentType]||0)+1;
  }
  return {documents:docs.size,chunks:(chunks||[]).length,clauses:clauses.size,types};
}

export function validateGroundedAnswer(answer,candidateIds=[]){
  const valid=new Set(candidateIds||[]),citations=uniq((answer?.citations||[]).map(String).filter(id=>valid.has(id)));
  return {
    ...answer,
    citations,
    grounded:citations.length>0,
    status:citations.length?String(answer?.status||"supported"):"not_found"
  };
}
