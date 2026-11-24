use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct MeetingTranscriptRow {
    pub time_label: String,
    pub speaker: String,
    pub text: String,
}

impl Default for MeetingTranscriptRow {
    fn default() -> Self {
        Self {
            time_label: String::new(),
            speaker: String::new(),
            text: String::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct MeetingDocxRequest {
    pub title: String,
    pub date_str: String,
    pub location: String,
    pub attendees: String,
    pub secretary: String,
    pub summary_lines: Vec<String>,
    pub decision_lines: Vec<String>,
    pub action_lines: Vec<String>,
    pub transcript_rows: Vec<MeetingTranscriptRow>,
    pub output_path: String,
}

impl Default for MeetingDocxRequest {
    fn default() -> Self {
        Self {
            title: "รายงานการประชุม".to_string(),
            date_str: String::new(),
            location: String::new(),
            attendees: String::new(),
            secretary: String::new(),
            summary_lines: Vec::new(),
            decision_lines: Vec::new(),
            action_lines: Vec::new(),
            transcript_rows: Vec::new(),
            output_path: String::new(),
        }
    }
}

fn xml_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 16);
    for ch in input.chars() {
        let code = ch as u32;
        // Strip XML 1.0 illegal control characters
        if code < 0x20 && ch != '\t' && ch != '\n' && ch != '\r' {
            continue;
        }
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

fn crc32_ieee(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            if (crc & 1) != 0 {
                crc = (crc >> 1) ^ 0xEDB8_8320;
            } else {
                crc >>= 1;
            }
        }
    }
    !crc
}

/// Pure-Rust zero-dependency ZIP writer (STORE method 0 — 100% valid for Microsoft Word / Google Docs / LibreOffice)
fn build_zip_store(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut central_dir: Vec<u8> = Vec::new();

    for &(name, data) in entries {
        let name_bytes = name.as_bytes();
        let crc = crc32_ieee(data);
        let size = data.len() as u32;
        let offset = out.len() as u32;

        // Local file header
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed (2.0)
        out.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 flag
        out.extend_from_slice(&0u16.to_le_bytes()); // compression method: STORE
        out.extend_from_slice(&0u16.to_le_bytes()); // mod time
        out.extend_from_slice(&0x5421u16.to_le_bytes()); // mod date
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra len
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(data);

        // Central directory header
        central_dir.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central_dir.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central_dir.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central_dir.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 flag
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // STORE
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // mod time
        central_dir.extend_from_slice(&0x5421u16.to_le_bytes()); // mod date
        central_dir.extend_from_slice(&crc.to_le_bytes());
        central_dir.extend_from_slice(&size.to_le_bytes());
        central_dir.extend_from_slice(&size.to_le_bytes());
        central_dir.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // extra len
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // comment len
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // disk start
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        central_dir.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central_dir.extend_from_slice(&offset.to_le_bytes());
        central_dir.extend_from_slice(name_bytes);
    }

    let cd_offset = out.len() as u32;
    let cd_size = central_dir.len() as u32;
    let count = entries.len() as u16;
    out.extend_from_slice(&central_dir);

    // End of central directory record
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());

    out
}

fn rpr(size_half_pt: u32, bold: bool, color_hex: &str) -> String {
    let b_xml = if bold { "<w:b/><w:bCs/>" } else { "" };
    format!(
        r#"<w:rPr><w:rFonts w:ascii="TH Sarabun New" w:hAnsi="TH Sarabun New" w:cs="TH Sarabun New" w:eastAsia="Sarabun"/>{}<w:color w:val="{}"/><w:sz w:val="{}"/><w:szCs w:val="{}"/></w:rPr>"#,
        b_xml, color_hex, size_half_pt, size_half_pt
    )
}

fn para_text(text: &str, size_half_pt: u32, bold: bool, color_hex: &str, space_after: u32, indent_left: u32) -> String {
    let ind = if indent_left > 0 {
        format!(r#"<w:ind w:left="{}"/>"#, indent_left)
    } else {
        String::new()
    };
    format!(
        r#"<w:p><w:pPr><w:spacing w:before="40" w:after="{}" w:line="276" w:lineRule="auto"/>{}</w:pPr><w:r>{}<w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
        space_after,
        ind,
        rpr(size_half_pt, bold, color_hex),
        xml_escape(text)
    )
}

fn section_heading(title: &str) -> String {
    format!(
        r#"<w:p><w:pPr><w:spacing w:before="220" w:after="100"/><w:pBdr><w:bottom w:val="single" w:sz="8" w:space="4" w:color="4F46E5"/></w:pBdr></w:pPr><w:r>{}<w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
        rpr(36, true, "1E1B4B"),
        xml_escape(title)
    )
}

fn meta_row(label: &str, value: &str) -> String {
    let v = if value.trim().is_empty() { "-" } else { value.trim() };
    format!(
        r#"<w:tr>
          <w:tc>
            <w:tcPr><w:tcW w:w="2600" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="EEF2FF"/></w:tcPr>
            <w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr><w:r>{}<w:t xml:space="preserve">{}</w:t></w:r></w:p>
          </w:tc>
          <w:tc>
            <w:tcPr><w:tcW w:w="6800" w:type="dxa"/></w:tcPr>
            <w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr><w:r>{}<w:t xml:space="preserve">{}</w:t></w:r></w:p>
          </w:tc>
        </w:tr>"#,
        rpr(32, true, "1E1B4B"),
        xml_escape(label),
        rpr(32, false, "111827"),
        xml_escape(v)
    )
}

fn build_document_xml(req: &MeetingDocxRequest) -> String {
    let mut body = String::new();

    // Document Title Banner
    let title = if req.title.trim().is_empty() {
        "รายงานการประชุม"
    } else {
        req.title.trim()
    };
    body.push_str(&format!(
        r#"<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="80"/></w:pPr><w:r>{}<w:t xml:space="preserve">รายงานการประชุม</w:t></w:r></w:p>"#,
        rpr(44, true, "1E1B4B")
    ));
    body.push_str(&format!(
        r#"<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="200"/></w:pPr><w:r>{}<w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
        rpr(38, true, "4338CA"),
        xml_escape(title)
    ));

    // Metadata Table
    body.push_str(r#"<w:tbl><w:tblPr><w:tblW w:w="9400" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/><w:left w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/><w:right w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/></w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr>"#);
    body.push_str(&meta_row("หัวข้อการประชุม", title));
    body.push_str(&meta_row("วันที่ / เวลา", &req.date_str));
    body.push_str(&meta_row("สถานที่ / ช่องทาง", &req.location));
    body.push_str(&meta_row("ผู้เข้าร่วมประชุม", &req.attendees));
    body.push_str(&meta_row("ผู้จดรายงานการประชุม", &req.secretary));
    body.push_str("</w:tbl>");

    // Section 1: Executive Summary
    body.push_str(&section_heading("1. สรุปสาระสำคัญของการประชุม"));
    let summary_nonempty: Vec<&String> = req.summary_lines.iter().filter(|s| !s.trim().is_empty()).collect();
    if summary_nonempty.is_empty() {
        body.push_str(&para_text("- (ยังไม่ได้ระบุสรุปสาระสำคัญ)", 32, false, "64748B", 80, 240));
    } else {
        for line in summary_nonempty {
            let trimmed = line.trim();
            let txt = if trimmed.starts_with('•') || trimmed.starts_with('-') {
                trimmed.to_string()
            } else {
                format!("•  {}", trimmed)
            };
            body.push_str(&para_text(&txt, 32, false, "111827", 80, 240));
        }
    }

    // Section 2: Key Decisions
    body.push_str(&section_heading("2. มติที่ประชุม / ข้อตกลงสำคัญ"));
    let dec_nonempty: Vec<&String> = req.decision_lines.iter().filter(|s| !s.trim().is_empty()).collect();
    if dec_nonempty.is_empty() {
        body.push_str(&para_text("- (ไม่มีมติเพิ่มเติม)", 32, false, "64748B", 80, 240));
    } else {
        for (i, line) in dec_nonempty.iter().enumerate() {
            body.push_str(&para_text(&format!("{}.  {}", i + 1, line.trim()), 32, false, "111827", 80, 240));
        }
    }

    // Section 3: Action Items
    body.push_str(&section_heading("3. รายการงานมอบหมายและติดตามผล (Action Items)"));
    let act_nonempty: Vec<&String> = req.action_lines.iter().filter(|s| !s.trim().is_empty()).collect();
    if act_nonempty.is_empty() {
        body.push_str(&para_text("- (ไม่มีรายการติดตามงานเพิ่มเติม)", 32, false, "64748B", 80, 240));
    } else {
        for (i, line) in act_nonempty.iter().enumerate() {
            body.push_str(&para_text(&format!("[ ] {}.  {}", i + 1, line.trim()), 32, false, "111827", 80, 240));
        }
    }

    // Section 4: Full Transcript
    body.push_str(&section_heading("4. บทถอดเสียงการประชุมฉบับเต็ม"));
    if req.transcript_rows.is_empty() {
        body.push_str(&para_text("- (ยังไม่มีบทถอดเสียง)", 32, false, "64748B", 80, 240));
    } else {
        for row in &req.transcript_rows {
            let txt = row.text.trim();
            if txt.is_empty() {
                continue;
            }
            let ts = row.time_label.trim();
            let spk = row.speaker.trim();
            let mut runs = String::new();
            if !ts.is_empty() {
                runs.push_str(&format!(
                    r#"<w:r>{}<w:t xml:space="preserve">[{}] </w:t></w:r>"#,
                    rpr(28, false, "64748B"),
                    xml_escape(ts)
                ));
            }
            if !spk.is_empty() {
                runs.push_str(&format!(
                    r#"<w:r>{}<w:t xml:space="preserve">{}: </w:t></w:r>"#,
                    rpr(32, true, "1E40AF"),
                    xml_escape(spk)
                ));
            }
            runs.push_str(&format!(
                r#"<w:r>{}<w:t xml:space="preserve">{}</w:t></w:r>"#,
                rpr(32, false, "111827"),
                xml_escape(txt)
            ));
            body.push_str(&format!(
                r#"<w:p><w:pPr><w:spacing w:before="30" w:after="70" w:line="276" w:lineRule="auto"/></w:pPr>{}</w:p>"#,
                runs
            ));
        }
    }

    // Footer Note
    body.push_str(&para_text(
        "จัดทำรายงานการประชุมด้วย AutoSubAI Desktop Studio (www.thaiautosub.com)",
        24,
        false,
        "94A3B8",
        0,
        0,
    ));

    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    {}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>"#,
        body
    )
}

pub async fn write_meeting_docx(req: &MeetingDocxRequest) -> Result<String, String> {
    let out_path_str = req.output_path.trim();
    if out_path_str.is_empty() {
        return Err("ไม่ได้ระบุตำแหน่งบันทึกไฟล์ Word (.docx)".to_string());
    }
    let out_path = Path::new(out_path_str);
    if let Some(parent) = out_path.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("สร้างโฟลเดอร์ไม่สำเร็จ: {}", e))?;
        }
    }

    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"#;

    let root_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;

    let doc_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#;

    let styles_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="TH Sarabun New" w:hAnsi="TH Sarabun New" w:cs="TH Sarabun New" w:eastAsia="Sarabun"/>
        <w:sz w:val="32"/>
        <w:szCs w:val="32"/>
      </w:rPr>
    </w:rPrDefault>
  </w:docDefaults>
</w:styles>"#;

    let document_xml = build_document_xml(req);

    let zip_bytes = build_zip_store(&[
        ("[Content_Types].xml", content_types.as_bytes()),
        ("_rels/.rels", root_rels.as_bytes()),
        ("word/_rels/document.xml.rels", doc_rels.as_bytes()),
        ("word/styles.xml", styles_xml.as_bytes()),
        ("word/document.xml", document_xml.as_bytes()),
    ]);

    tokio::fs::write(out_path, &zip_bytes)
        .await
        .map_err(|e| format!("บันทึกไฟล์ Word (.docx) ไม่สำเร็จ: {}", e))?;

    Ok(out_path.to_string_lossy().to_string())
}
