(() => {
  const encoder=new TextEncoder();
  const hex=(number,width=4)=>number.toString(16).padStart(width,'0');
  const utf16=text=>Array.from({length:text.length},(_,index)=>hex(text.charCodeAt(index))).join('');
  let loaded;
  async function load() {
    const response=await fetch('/fonts/NotoSansSC-Regular.ttf');
    if (!response.ok) throw new Error('The PDF font is unavailable. Connect to download it and try again.');
    const bytes=await response.arrayBuffer();
    const view=new DataView(bytes);
    const u16=offset=>view.getUint16(offset);
    const i16=offset=>view.getInt16(offset);
    const u32=offset=>view.getUint32(offset);
    const table={};
    const decoder=new TextDecoder();
    for (let index=0;index<u16(4);index++) {
      const p=12+16*index;
      table[decoder.decode(new Uint8Array(bytes,p,4))]=u32(p+8);
    }
    const head=table.head, hhea=table.hhea;
    const unit=u16(head+18);
    const scale=value=>Math.round(value*1000/unit);
    const widths=Math.max(1,u16(hhea+34));
    const scalars=[];
    for (let n=0;n<u16(table.cmap+2);n++) {
      const pos=table.cmap+4+n*8;
      const offset=table.cmap+u32(pos+4);
      if (u16(offset)===12) scalars.push(offset);
    }
    const cmap=scalars[0];
    if (cmap===undefined) throw new Error('The PDF font does not contain a Unicode character map.');
    function glyph(code) {
      let low=0,high=u32(cmap+12)-1;
      while (low<=high) {
        const middle=(low+high)>>>1;
        const entry=cmap+16+12*middle;
        if (code<u32(entry)) high=middle-1;
        else if (code>u32(entry+4)) low=middle+1;
        else return u32(entry+8)+code-u32(entry);
      }
      return 0;
    }
    const advance=char=>scale(u16(table.hmtx+4*Math.min(widths-1,glyph(char.codePointAt(0)))));
    const font=typeof CompressionStream==='function' ?
      new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer()) : new Uint8Array(bytes);
    return {glyph,advance,font,length:bytes.byteLength,compressed:typeof CompressionStream==='function',
      bbox:[36,38,40,42].map(offset=>scale(i16(head+offset))),ascent:scale(i16(hhea+4)),descent:scale(i16(hhea+6))};
  }
  async function face() {
    const data=await (loaded ||= load().catch(error=>{loaded=null;throw error;}));
    const chars=new Map();
    function encode(value) {
      let out='';
      for (const char of value) {
        if (!chars.has(char)) chars.set(char,chars.size+1);
        out+=hex(chars.get(char));
      }
      return '<'+out+'>';
    }
    function embed(put,fontObject) {
      const stream=(body,extra='')=>{
        const bytes=typeof body==='string'?encoder.encode(body):body;
        return put('<< /Length '+bytes.length+' '+extra+' >>\nstream\n',bytes,'\nendstream');
      };
      const program=stream(data.font,'/Length1 '+data.length+(data.compressed?' /Filter /FlateDecode':''));
      const descriptor=put(`<< /Type /FontDescriptor /FontName /NotoSansSC-Regular /Flags 4 /FontBBox [${data.bbox.join(' ')}]
        /ItalicAngle 0 /Ascent ${data.ascent} /Descent ${data.descent} /CapHeight 733 /StemV 85 /FontFile2 ${program} 0 R >>`);
      const entries=[...chars.keys()];
      const mapping=new Uint8Array((entries.length+1)*2);
      const mappingView=new DataView(mapping.buffer);
      entries.forEach((char,index)=>mappingView.setUint16((index+1)*2,data.glyph(char.codePointAt(0))));
      const map=stream(mapping);
      const cid=put(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /NotoSansSC-Regular
        /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>
        /FontDescriptor ${descriptor} 0 R /DW 1000 /W [1 [${entries.map(data.advance).join(' ')}]] /CIDToGIDMap ${map} 0 R >>`);
      const blocks=[];
      for (let index=0;index<entries.length;index+=90) {
        const lines=entries.slice(index,index+90).map((char,position)=>'<'+hex(index+position+1)+'> <'+utf16(char)+'>');
        blocks.push(lines.length+' beginbfchar\n'+lines.join('\n')+'\nendbfchar');
      }
      const unicode=stream('/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /FieldProofUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n'+
        blocks.join('\n')+'\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n');
      fontObject(`<< /Type /Font /Subtype /Type0 /BaseFont /NotoSansSC-Regular /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${unicode} 0 R >>`);
    }
    return {encode,embed,measure:(text,size)=>[...text].reduce((total,char)=>total+data.advance(char),0)*size/1000};
  }
  FP.pdfUnicode=face;
})();
