
import React, { useState, useEffect } from 'react';
import { GoogleGenAI, Type } from "@google/genai";

// --- Type Definitions ---
interface ScannerResult {
    companyName: string;
    paymentDate: string; // YYYY-MM-DD
    paymentDateDisplay: string; // DD/MM/YYYY
    paymentPeriod: string;
    receiptNumber: string;
    taxType: string;
    amount: number;
}

// --- Helper Functions ---
const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
};

const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-NG', {
        style: 'currency',
        currency: 'NGN',
        minimumFractionDigits: 2
    }).format(amount || 0);
};

// --- Main App Component ---
const App: React.FC = () => {
    // --- Global State ---
    const [ai, setAi] = useState<GoogleGenAI | null>(null);
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);

    // --- Scanner State ---
    const [scannerIsLoading, setScannerIsLoading] = useState(false);
    const [scannerResults, setScannerResults] = useState<ScannerResult[]>([]);
    const [scannerMessages, setScannerMessages] = useState<{ text: string, type: 'error' | 'success' | 'warning' }[]>([]);
    const [showDownloadModal, setShowDownloadModal] = useState(false);

    useEffect(() => {
        if (process.env.API_KEY) {
            setAi(new GoogleGenAI({ apiKey: process.env.API_KEY }));
        }
    }, []);

    // --- Handlers & Logic ---
    const handleFileChange = (files: FileList | null) => {
        if (!files) return;
        setSelectedFiles(Array.from(files));
        setScannerResults([]);
        setScannerMessages([]);
    };

    const handleDragOver = (e: React.DragEvent) => e.preventDefault();
    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        handleFileChange(e.dataTransfer.files);
    };

    const processFiles = () => {
        processReceipts();
    };

    // --- Scanner Logic ---
    const processReceipts = async () => {
        if (!ai) {
            setScannerMessages([{ text: "AI client not initialized.", type: 'error' }]);
            return;
        }
        setScannerIsLoading(true);
        setScannerMessages([]);
        setScannerResults([]);

        // Deduplication Set: Stores keys formatted as "receiptNumber-amount"
        const uniqueKeys = new Set<string>();
        const results: ScannerResult[] = [];

        for (const file of selectedFiles) {
            const maxSize = 19 * 1024 * 1024; // 19MB
            if (file.size > maxSize) {
                setScannerMessages(prev => [...prev, { text: `File skipped (too large): ${file.name}`, type: 'warning' }]);
                continue;
            }

            const mimeType = file.type;
            if (!['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(mimeType)) {
                setScannerMessages(prev => [...prev, { text: `Skipped: ${file.name}. Scanner accepts PNG, JPG, WebP, or PDF.`, type: 'warning' }]);
                continue;
            }

            try {
                const base64Data = await fileToBase64(file);
                const result = await callScannerGeminiAPI(ai, base64Data, mimeType);
                if (result && result.companyName) {
                    const uniqueKey = `${result.receiptNumber.trim()}-${result.amount}`;

                    if (uniqueKeys.has(uniqueKey)) {
                        setScannerMessages(prev => [...prev, { text: `Duplicate Receipt skipped: ${result.receiptNumber} in ${file.name}`, type: 'warning' }]);
                    } else {
                        uniqueKeys.add(uniqueKey);
                        results.push(result);
                        setScannerMessages(prev => [...prev, { text: `Successfully processed: ${file.name}`, type: 'success' }]);
                    }
                } else {
                    throw new Error("AI did not return valid data.");
                }
            } catch (error: any) {
                setScannerMessages(prev => [...prev, { text: `Failed to process file: ${file.name}. ${error.message}`, type: 'error' }]);
            }
        }

        results.sort((a, b) => new Date(a.paymentDate).getTime() - new Date(b.paymentDate).getTime());
        setScannerResults(results);
        setScannerIsLoading(false);
    };

    const callScannerGeminiAPI = async (ai: GoogleGenAI, base64Data: string, mimeType: string): Promise<ScannerResult> => {
        const systemPrompt = `You are an expert accountant. Extract ONLY the following fields from this receipt file.
        - companyName: The name of the company that made the payment.
        - paymentDate: The date the payment was made (e.g., "21/01/2025"). Use ISO format YYYY-MM-DD.
        - paymentPeriod: The month/year the payment covers (e.g., "Jan-25"). If not explicitly stated, infer it as the month PRIOR to the paymentDate. For a payment in "January 2024", the period is "Dec-23".
        - receiptNumber: The unique receipt or transaction number. Do NOT use the "AssessRef" or "Assessment Reference". Prioritize the "Transaction" number.
        - taxType: The specific type of tax paid. Look closely at "Agency - Rev Code", "Service Description", or "Payment Details". Examples: "Development Levy", "WHT ON DIRECTOR'S FEES", "PAYE", "Business Premises". Do NOT use generic terms like "Lagos Revenue Payment" or "Revenue Receipt" if a specific tax name (like "Development Levy") is visible.
        - amount: The FINAL TOTAL amount paid. If the receipt has multiple amount fields (like 'Amount', 'Charges', 'VAT', 'Total'), you MUST select the 'Total', 'Total Paid', or 'Total Amount'. For example, if 'Amount' is 900 and 'Total' is 950, return 950.
        Return ONLY a single valid JSON object. Do not add markdown or any other text.`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: { parts: [{ text: "Extract receipt data as JSON." }, { inlineData: { mimeType, data: base64Data } }] },
            config: {
                systemInstruction: systemPrompt,
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        "companyName": { "type": Type.STRING },
                        "paymentDate": { "type": Type.STRING, "description": "Date in YYYY-MM-DD format" },
                        "paymentPeriod": { "type": Type.STRING, "description": "Period in Mon-YY format (e.g., Jan-25)" },
                        "receiptNumber": { "type": Type.STRING },
                        "taxType": { "type": Type.STRING },
                        "amount": { "type": Type.NUMBER }
                    },
                    required: ["companyName", "paymentDate", "paymentPeriod", "receiptNumber", "taxType", "amount"]
                }
            }
        });

        let data = JSON.parse(response.text);
        if (!data.paymentPeriod && data.paymentDate) {
            const date = new Date(data.paymentDate);
            date.setMonth(date.getMonth() - 1);
            data.paymentPeriod = `${date.toLocaleString('default', { month: 'short' })}-${date.getFullYear().toString().slice(-2)}`;
        }
        if (data.paymentDate) {
            const date = new Date(data.paymentDate);
            data.paymentDateDisplay = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
        }
        return data;
    };

    const handleDownloadClick = () => {
        setShowDownloadModal(true);
    };

    const handleDownloadConfirm = (type: 'standard' | 'upload') => {
        setShowDownloadModal(false);
        downloadScannerExcel(type);
    };

    const downloadScannerExcel = (templateType: 'standard' | 'upload') => {
        const XLSX = (window as any).XLSX;
        if (!XLSX) {
            alert("Excel library not found!");
            return;
        }

        const wb = XLSX.utils.book_new();

        if (templateType === 'upload') {
            // --- Upload Template Logic (Single Sheet, Plain/Raw Data) ---
            const headers = ["REVENUE ITEM", "DATE OF PAYMENT", "AMOUNT PAID", "RECEIPT NUMBER", "PERIOD OF PAYMENT"];

            const sortedResults = [...scannerResults].sort((a, b) => new Date(a.paymentDate).getTime() - new Date(b.paymentDate).getTime());

            const dataRows = sortedResults.map(row => {
                let displayTaxType = row.taxType;
                const upperTax = displayTaxType.toUpperCase();

                // Normalize "Lagos Revenue Payment" or similar generic terms to "PAYE"
                if (upperTax.includes("LAGOS REVENUE PAYMENT") || upperTax === "REVENUE PAYMENT" || upperTax === "REVENUE RECEIPT") {
                    displayTaxType = "PAYE";
                }

                const isPaye = displayTaxType.toUpperCase().includes("PAYE");
                let periodVal = row.paymentPeriod;

                // Parse "Jan-25" -> Month: "JANUARY", Year: "2025"
                const parts = row.paymentPeriod.split('-');
                if (parts.length === 2) {
                    const monthMap: { [key: string]: string } = {
                        'Jan': 'JANUARY', 'Feb': 'FEBRUARY', 'Mar': 'MARCH', 'Apr': 'APRIL', 'May': 'MAY', 'Jun': 'JUNE',
                        'Jul': 'JULY', 'Aug': 'AUGUST', 'Sep': 'SEPTEMBER', 'Oct': 'OCTOBER', 'Nov': 'NOVEMBER', 'Dec': 'DECEMBER',
                        // Add lowercase handling just in case
                        'jan': 'JANUARY', 'feb': 'FEBRUARY', 'mar': 'MARCH', 'apr': 'APRIL', 'may': 'MAY', 'jun': 'JUNE',
                        'jul': 'JULY', 'aug': 'AUGUST', 'sep': 'SEPTEMBER', 'oct': 'OCTOBER', 'nov': 'NOVEMBER', 'dec': 'DECEMBER'
                    };
                    const m = parts[0];
                    // Ensure year is 4 digits
                    const y = parts[1].length === 2 ? '20' + parts[1] : parts[1];

                    if (isPaye) {
                        // For PAYE: "JANUARY"
                        periodVal = monthMap[m] || monthMap[m.toLowerCase()] || m.toUpperCase();
                    } else {
                        // For Others (Levy, etc): "2025"
                        periodVal = y;
                    }
                } else {
                    // Fallback
                    const d = new Date(row.paymentDate);
                    if (isPaye) periodVal = d.toLocaleString('default', { month: 'long' }).toUpperCase();
                    else periodVal = d.getFullYear().toString();
                }

                return [
                    displayTaxType,
                    new Date(row.paymentDate),
                    row.amount,
                    row.receiptNumber,
                    periodVal
                ];
            });

            // Create sheet directly with headers and data, no styles applied
            const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);

            // Apply basic date formatting so it appears as DD/MM/YYYY
            const range = XLSX.utils.decode_range(ws['!ref'] || "A1");
            for (let R = range.s.r; R <= range.e.r; ++R) {
                const C = 1; // Column B (Date)
                const cellRef = XLSX.utils.encode_cell({ c: C, r: R });
                // Skip header row
                if (ws[cellRef] && R > 0) {
                    ws[cellRef].z = 'dd/mm/yyyy';
                }
            }

            // Column Widths (for readability)
            ws['!cols'] = [{ wch: 30 }, { wch: 15 }, { wch: 15 }, { wch: 25 }, { wch: 20 }];

            XLSX.utils.book_append_sheet(wb, ws, "Upload");
            XLSX.writeFile(wb, "Lagos_State_Upload_Schedule.xlsx");

        } else {
            // --- Standard Template Logic (Styled with Borders & Colors) ---
            const dataByYear: { [key: string]: ScannerResult[] } = {};
            const getYearFromPeriod = (period?: string) => {
                if (!period) return "Unknown";
                const match = period.match(/(\d{2,4})$/);
                return match ? (match[1].length === 2 ? `20${match[1]}` : match[1]) : "Unknown";
            };

            scannerResults.forEach(row => {
                const year = getYearFromPeriod(row.paymentPeriod);
                if (!dataByYear[year]) dataByYear[year] = [];
                dataByYear[year].push(row);
            });

            // Variables for filename generation
            const companyFrequency: Record<string, number> = {};
            const extractedTaxTypes = new Set<string>();

            scannerResults.forEach(row => {
                if (row.companyName) {
                    companyFrequency[row.companyName] = (companyFrequency[row.companyName] || 0) + 1;
                }
                if (row.taxType) {
                    const t = row.taxType.toUpperCase();
                    if (t.includes("WHT") || t.includes("WITHHOLDING")) extractedTaxTypes.add("WHT");
                    else if (t.includes("VAT") || t.includes("VALUE ADDED")) extractedTaxTypes.add("VAT");
                    else if (t.includes("PAYE") || t.includes("PAY AS YOU EARN")) extractedTaxTypes.add("PAYE");
                    else if (t.includes("CIT") || t.includes("COMPANY INCOME")) extractedTaxTypes.add("CIT");
                    else if (t.includes("EDT") || t.includes("EDUCATION")) extractedTaxTypes.add("EDT");
                    else extractedTaxTypes.add("TAX");
                }
            });

            // Common styles
            const thinBorder = { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } };
            const headerStyle = { font: { bold: true, sz: 11 }, border: thinBorder, alignment: { horizontal: "center", vertical: "center" }, fill: { fgColor: { rgb: "EEEEEE" } } };
            const dataStyle = { border: thinBorder, font: { sz: 11 } };
            const titleStyle = { font: { bold: true, sz: 14 } };

            for (const year in dataByYear) {
                const sheetData = dataByYear[year].sort((a, b) => new Date(a.paymentDate).getTime() - new Date(b.paymentDate).getTime());

                // Determine dominant company name for the title
                const companyCounts = sheetData.reduce((acc, row) => {
                    const name = row.companyName || "Unknown";
                    acc[name] = (acc[name] || 0) + 1;
                    return acc;
                }, {} as Record<string, number>);
                const titleName = Object.keys(companyCounts).reduce((a, b) => companyCounts[a] > companyCounts[b] ? a : b, "NASD PLC");
                const total = sheetData.reduce((sum, row) => sum + (row.amount || 0), 0);

                // Build Worksheet Data manually to apply styles
                const ws = XLSX.utils.aoa_to_sheet([]);

                // -- Row 0: Company Title --
                XLSX.utils.sheet_add_aoa(ws, [[titleName]], { origin: "A1" });
                if (ws['A1']) ws['A1'].s = titleStyle;

                // -- Row 1: Period Title --
                XLSX.utils.sheet_add_aoa(ws, [[`REMITTANCE SCHEDULE FOR ${year}`]], { origin: "A2" });
                if (ws['A2']) ws['A2'].s = { font: { bold: true, sz: 12 } };

                // -- Row 3: Headers -- (Skipping row 2 as spacer)
                const headers = ["PAYMENT DATE", "PERIOD", "RECEIPT NUMBER", "TAX TYPE", "AMOUNT [N]"];
                XLSX.utils.sheet_add_aoa(ws, [headers], { origin: "A4" });

                // Apply header styles (A4:E4)
                ['A4', 'B4', 'C4', 'D4', 'E4'].forEach(ref => {
                    if (ws[ref]) ws[ref].s = headerStyle;
                });

                // -- Rows 4+: Data --
                const dataRows = sheetData.map(row => [
                    row.paymentDate ? new Date(row.paymentDate) : undefined,
                    row.paymentPeriod,
                    row.receiptNumber,
                    row.taxType,
                    row.amount
                ]);

                XLSX.utils.sheet_add_aoa(ws, dataRows, { origin: "A5" });

                // Apply styles and formats to data cells
                const startRow = 4; // 0-indexed relative to sheet, so row 5
                dataRows.forEach((row, idx) => {
                    const r = startRow + idx;

                    // Date Cell (A)
                    const dateRef = XLSX.utils.encode_cell({ c: 0, r });
                    if (ws[dateRef]) {
                        ws[dateRef].z = 'dd/mm/yyyy';
                        ws[dateRef].s = { ...dataStyle, alignment: { horizontal: "center" } };
                    }

                    // Period (B), Receipt (C), Tax Type (D)
                    [1, 2, 3].forEach(c => {
                        const ref = XLSX.utils.encode_cell({ c, r });
                        if (ws[ref]) ws[ref].s = dataStyle;
                    });

                    // Amount Cell (E)
                    const amtRef = XLSX.utils.encode_cell({ c: 4, r });
                    if (ws[amtRef]) {
                        ws[amtRef].z = '#,##0.00';
                        ws[amtRef].s = dataStyle;
                    }
                });

                // -- Total Row --
                const totalRowIndex = startRow + dataRows.length + 1; // +1 for spacer
                XLSX.utils.sheet_add_aoa(ws, [["", "", "", "Total", total]], { origin: { r: totalRowIndex, c: 0 } });

                const totalLabelRef = XLSX.utils.encode_cell({ c: 3, r: totalRowIndex });
                const totalValRef = XLSX.utils.encode_cell({ c: 4, r: totalRowIndex });

                if (ws[totalLabelRef]) ws[totalLabelRef].s = { font: { bold: true } };
                if (ws[totalValRef]) {
                    ws[totalValRef].z = '#,##0.00';
                    ws[totalValRef].s = { font: { bold: true }, border: { bottom: { style: "double" } } };
                }

                // Column Widths
                ws['!cols'] = [{ wch: 15 }, { wch: 12 }, { wch: 30 }, { wch: 30 }, { wch: 20 }];

                XLSX.utils.book_append_sheet(wb, ws, `Remittance ${year}`);
            }

            // Generate Dynamic Filename
            let dominantCompany = "Unknown_Company";
            const companyNames = Object.keys(companyFrequency);
            if (companyNames.length > 0) {
                dominantCompany = companyNames.reduce((a, b) => companyFrequency[a] > companyFrequency[b] ? a : b);
            }

            const safeCompanyName = dominantCompany.replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "_");
            const taxTypesStr = Array.from(extractedTaxTypes).sort().join("_") || "Remittance";

            const filename = `${safeCompanyName}_${taxTypesStr}_Schedule.xlsx`;

            XLSX.writeFile(wb, filename);
        }
    };

    return (
        <div className="w-full max-w-7xl mx-auto relative min-h-screen bg-slate-900 text-slate-100 p-8">
            {showDownloadModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="bg-slate-900 border border-white/10 rounded-xl p-6 max-w-md w-full shadow-2xl glow-border">
                        <h3 className="text-xl font-bold text-white mb-4">Select Schedule Format</h3>
                        <p className="text-slate-400 mb-6">How do you intend to use this schedule?</p>
                        <div className="space-y-3">
                            <button
                                onClick={() => handleDownloadConfirm('upload')}
                                className="w-full py-3 px-4 bg-violet-600 hover:bg-violet-700 text-white rounded-lg font-medium transition-colors flex items-center justify-center"
                            >
                                <span className="mr-2">📤</span> For Portal Upload
                            </button>
                            <button
                                onClick={() => handleDownloadConfirm('standard')}
                                className="w-full py-3 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium transition-colors flex items-center justify-center"
                            >
                                <span className="mr-2">📎</span> As Attachment (Standard)
                            </button>
                        </div>
                        <button
                            onClick={() => setShowDownloadModal(false)}
                            className="mt-4 w-full py-2 text-slate-500 hover:text-slate-300 text-sm"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            <header className="mb-8 text-center border-b border-white/10 pb-6">
                <h1 className="text-4xl font-bold text-slate-100 tracking-wider">REMITTANCE SCHEDULE TOOL</h1>
                <p className="text-slate-400 mt-2">Extract and organize receipt data instantly.</p>
            </header>

            <main>
                <div className="bg-slate-900/50 backdrop-blur-sm rounded-xl shadow-lg p-6 mb-8 glow-border">
                    <div
                        onDragOver={handleDragOver}
                        onDrop={handleDrop}
                        className="border-2 border-dashed border-slate-700 rounded-lg p-8 text-center hover:border-violet-500 transition-colors"
                    >
                        <label htmlFor="file-upload" className="cursor-pointer">
                            <svg className="mx-auto h-12 w-12 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l-3.75 3.75M12 9.75l3.75 3.75M3 13.5v6c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-6m-16-4.5c0-1.1.9-2 2-2h14c1.1 0 2 .9 2 2v2.25M7.5 16.5v-3.75m9 3.75v-3.75" />
                            </svg>
                            <span className="mt-2 block text-sm font-medium text-slate-200">
                                Drag & drop files here or <span className="text-violet-400">click to browse</span>
                            </span>
                            <span className="mt-1 block text-xs text-slate-500">
                                PDF, PNG, JPG, WebP
                            </span>
                        </label>
                        <input id="file-upload" name="file-upload" type="file" className="sr-only" multiple accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={(e) => handleFileChange(e.target.files)} />
                    </div>

                    {selectedFiles.length > 0 && (
                        <div className="mt-4">
                            <h4 className="font-medium text-slate-300">Selected Files:</h4>
                            <ul className="list-disc list-inside text-sm text-slate-400 mt-2">
                                {selectedFiles.map(file => <li key={file.name}>{file.name}</li>)}
                            </ul>
                        </div>
                    )}

                    <div className="mt-6 text-center">
                        <button
                            onClick={processFiles}
                            disabled={selectedFiles.length === 0 || scannerIsLoading}
                            className="inline-flex items-center justify-center px-8 py-3 border border-transparent text-base font-medium rounded-md shadow-lg text-white disabled:bg-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed bg-violet-600 hover:bg-violet-700 transition duration-300"
                        >
                            {scannerIsLoading && <div className='mr-2 w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin'></div>}
                            Process Files
                        </button>
                    </div>
                </div>

                <div className="space-y-6">
                    {scannerIsLoading && (
                        <div className="flex flex-col items-center justify-center bg-slate-900/50 backdrop-blur-sm p-8 rounded-xl shadow-lg glow-border">
                            <div className="w-8 h-8 border-4 border-violet-500 border-t-transparent rounded-full animate-spin"></div>
                            <p className="mt-4 text-slate-400">Processing receipts...</p>
                        </div>
                    )}
                    {scannerMessages.length > 0 && (
                        <div className="space-y-2">
                            {scannerMessages.map((msg, index) => (
                                <div key={index} className={`p-4 rounded-md text-sm border ${msg.type === 'success' ? 'bg-teal-900/50 text-teal-200 border-teal-500/30' :
                                        msg.type === 'error' ? 'bg-red-900/50 text-red-200 border-red-500/30' :
                                            'bg-yellow-900/50 text-yellow-200 border-yellow-500/30'
                                    }`}>
                                    {msg.text}
                                </div>
                            ))}
                        </div>
                    )}

                    {scannerResults.length > 0 && (
                        <div className="bg-slate-900/50 backdrop-blur-sm rounded-xl shadow-lg overflow-hidden glow-border">
                            <div className="px-6 py-4 bg-slate-900/70 border-b border-white/10 flex justify-between items-center">
                                <h2 className="text-lg font-semibold text-violet-300">Scanner Results</h2>
                                <button
                                    onClick={handleDownloadClick}
                                    className="px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-teal-600 hover:bg-teal-700 transition-colors"
                                >
                                    Download Schedule
                                </button>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="min-w-full">
                                    <thead className="bg-slate-900/70">
                                        <tr>
                                            <th className="px-6 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">Payment Date</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">Period</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">Receipt No.</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">Tax Type</th>
                                            <th className="px-6 py-3 text-right text-xs font-medium text-violet-300 uppercase tracking-wider">Amount</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-white/10">
                                        {scannerResults.map((result, index) => (
                                            <tr key={result.receiptNumber + index} className="hover:bg-slate-800/40 transition-colors">
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300">{result.paymentDateDisplay}</td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300">{result.paymentPeriod}</td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300">{result.receiptNumber}</td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300">{result.taxType}</td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300 text-right">{formatCurrency(result.amount)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
};

export default App;
