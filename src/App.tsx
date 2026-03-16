import { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Type, FunctionDeclaration, GenerateContentResponse } from '@google/genai';
import { Send, Image as ImageIcon, Map, Loader2, AlertCircle, Search, Globe } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Initialize Gemini API
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Define Earth Engine Tool
const queryEarthEngineDeclaration: FunctionDeclaration = {
  name: 'queryEarthEngine',
  description: 'Queries the Google Earth Engine REST API to perform geospatial analysis, retrieve satellite imagery, or compute statistics. Use this tool when the user asks about satellite data, forest fires, land cover, or any Earth Engine related analysis.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      endpoint: {
        type: Type.STRING,
        description: 'The Earth Engine REST API endpoint to call (e.g., "projects/earthengine-public/image:computePixels", "projects/earthengine-public/value:compute").',
      },
      payload: {
        type: Type.OBJECT,
        description: 'The JSON payload to send to the Earth Engine REST API endpoint. This should contain the Earth Engine expression tree or other required parameters.',
      },
      explanation: {
        type: Type.STRING,
        description: 'A brief explanation of what this Earth Engine query is doing.',
      }
    },
    required: ['endpoint', 'payload', 'explanation'],
  },
};

// Define Google Maps Tool (delegates to 2.5)
const searchGoogleMapsDeclaration: FunctionDeclaration = {
  name: 'searchGoogleMaps',
  description: 'Search Google Maps for places, locations, restaurants, or geographic details. Use this when the user asks for nearby places or specific locations. DO NOT use this for calculating distances or getting directions between two places; use the googleSearch tool for distances and directions instead.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'The search query for Google Maps (e.g., "good Italian restaurants nearby", "coordinates of Eiffel Tower", "hospitals in San Francisco").',
      }
    },
    required: ['query'],
  },
};

interface Message {
  role: 'user' | 'model';
  text: string;
  files?: { data: string; mimeType: string; name: string }[];
  toolCalls?: { name: string; args: any; result?: any }[];
  isThinking?: boolean;
  groundingChunks?: any[];
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [selectedModel, setSelectedModel] = useState<'gemini-3.1-pro-preview' | 'gemini-3-flash-preview'>('gemini-3.1-pro-preview');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setSelectedFiles(Array.from(e.target.files));
    }
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          // Remove the data URL prefix (e.g., "data:image/jpeg;base64,")
          const base64 = reader.result.split(',')[1];
          resolve(base64);
        } else {
          reject(new Error('Failed to convert file to base64'));
        }
      };
      reader.onerror = error => reject(error);
    });
  };

  const executeEarthEngineQuery = async (endpoint: string, payload: any) => {
    try {
      const response = await fetch('/api/earthengine/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint, payload }),
      });
      const data = await response.json();
      return data;
    } catch (error) {
      return { error: String(error) };
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() && selectedFiles.length === 0) return;

    const userText = input;
    const files = [...selectedFiles];
    setInput('');
    setSelectedFiles([]);
    setIsLoading(true);

    try {
      const fileData = await Promise.all(
        files.map(async (file) => ({
          data: await fileToBase64(file),
          mimeType: file.type,
          name: file.name,
        }))
      );

      const newUserMessage: Message = {
        role: 'user',
        text: userText,
        files: fileData,
      };

      setMessages((prev) => [...prev, newUserMessage]);

      // Prepare contents for Gemini
      const contents = messages.map((m) => {
        const parts: any[] = [];
        if (m.text) parts.push({ text: m.text });
        if (m.files) {
          m.files.forEach((f) => {
            parts.push({
              inlineData: {
                data: f.data,
                mimeType: f.mimeType,
              },
            });
          });
        }
        return { role: m.role, parts };
      });

      // Add the new user message
      const newUserParts: any[] = [];
      if (userText) newUserParts.push({ text: userText });
      fileData.forEach((f) => {
        newUserParts.push({
          inlineData: {
            data: f.data,
            mimeType: f.mimeType,
          },
        });
      });
      contents.push({ role: 'user', parts: newUserParts });

      // Add a thinking message
      setMessages((prev) => [...prev, { role: 'model', text: '', isThinking: true }]);

      const baseConfig: any = {
        systemInstruction: `You are GeoAI, an advanced geospatial and visual-analysis assistant powered by Google Earth Engine. You have access to Google Search, a custom Earth Engine tool, and a Google Maps search tool. 
        
        Today's date is: ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}
        
        When asked about geospatial data, satellite imagery, or environmental analysis (like forest fires), use your tools to provide accurate, data-driven answers. Explain your process clearly. You can use all or any of your tools at the same time in a single request if needed to fully answer the user's query. You are never limited to just one tool. 
        
        - If you need to use Earth Engine, use the queryEarthEngine tool. 
        - If you need to search for local places, restaurants, or specific locations, use the searchGoogleMaps tool. 
        - If you need to find the distance between two places, get directions, or find general information, use the googleSearch tool.
        - If the user provides a visual description of a location (e.g., "railroad tracks looking north at Chicago skyline Willis Tower with large wall on right"), DO NOT refuse the request. You CAN and MUST process visual descriptions. Use your googleSearch and searchGoogleMaps tools to triangulate the location, find viewpoints, or identify the specific place being described based on the landmarks and spatial relationships provided.
        - You are highly encouraged to proactively extract and analyze any or all media on websites and searches when you need to. You do not need to ask for permission to do this.
        - You can reverse image search any image when you need to without asking. This includes images you find during your analysis (such as screen captures, satellite data, images attached to websites, etc.) and images uploaded by the user. Analyze the image carefully to identify its contents, landmarks, or text, and use the googleSearch tool to reverse-search those specific details to find its source, location, or related information.
        
        If Earth Engine credentials are not configured, explain that to the user and use Google Search/Maps as a fallback to provide the best possible answer.`,
        tools: [
          { googleSearch: {} },
          { functionDeclarations: [queryEarthEngineDeclaration, searchGoogleMapsDeclaration] }
        ],
      };

      const responseStream = await ai.models.generateContentStream({
        model: selectedModel,
        contents,
        config: baseConfig,
      });

      // Remove thinking message
      setMessages((prev) => prev.filter((m) => !m.isThinking));
      
      // Add empty message for streaming
      setMessages((prev) => [...prev, { role: 'model', text: '' }]);

      let modelText = '';
      let groundingChunks: any[] = [];
      let functionCalls: any[] = [];
      let responseContent: any = null;

      for await (const chunk of responseStream) {
        if (chunk.text) {
          modelText += chunk.text;
          setMessages((prev) => {
            const newMessages = [...prev];
            newMessages[newMessages.length - 1].text = modelText;
            return newMessages;
          });
        }
        if (chunk.functionCalls) {
          functionCalls.push(...chunk.functionCalls);
        }
        if (chunk.candidates?.[0]?.groundingMetadata?.groundingChunks) {
          groundingChunks = chunk.candidates[0].groundingMetadata.groundingChunks;
          setMessages((prev) => {
            const newMessages = [...prev];
            newMessages[newMessages.length - 1].groundingChunks = groundingChunks;
            return newMessages;
          });
        }
        if (chunk.candidates?.[0]?.content) {
          if (!responseContent) {
            responseContent = { role: 'model', parts: [] };
          }
          responseContent.parts.push(...chunk.candidates[0].content.parts);
        }
      }

      const toolCalls: { name: string; args: any; result?: any }[] = [];

      if (functionCalls.length > 0) {
        // Remove the empty message if modelText is empty
        if (!modelText) {
          setMessages((prev) => prev.slice(0, -1));
        }

        const functionResponses: any[] = [];
        const allMapsChunks: any[] = [];
        
        // Add a single message showing all tool calls
        setMessages((prev) => [...prev, { 
          role: 'model', 
          text: `*Executing tools...*`,
          toolCalls: functionCalls.map(c => ({ name: c.name, args: c.args }))
        }]);

        for (const call of functionCalls) {
          if (call.name === 'queryEarthEngine') {
            // Set initial state
            setMessages((prev) => {
              const newMessages = [...prev];
              const lastMessage = newMessages[newMessages.length - 1];
              if (lastMessage && lastMessage.toolCalls) {
                const tc = lastMessage.toolCalls.find(t => t.name === call.name);
                if (tc) tc.result = { status: 'running' };
              }
              return newMessages;
            });

            const args = call.args as any;
            const result = await executeEarthEngineQuery(args.endpoint, args.payload);
            functionResponses.push({
              name: call.name,
              response: result,
              id: (call as any).id
            });
            
            // Update the tool call with the result
            setMessages((prev) => {
              const newMessages = [...prev];
              const lastMessage = newMessages[newMessages.length - 1];
              if (lastMessage && lastMessage.toolCalls) {
                const tc = lastMessage.toolCalls.find(t => t.name === call.name);
                if (tc) tc.result = result;
              }
              return newMessages;
            });
          } else if (call.name === 'searchGoogleMaps') {
            // Set initial state
            setMessages((prev) => {
              const newMessages = [...prev];
              const lastMessage = newMessages[newMessages.length - 1];
              if (lastMessage && lastMessage.toolCalls) {
                const tc = lastMessage.toolCalls.find(t => t.name === call.name);
                if (tc) tc.result = { text: '', places: [] };
              }
              return newMessages;
            });

            const args = call.args as any;
            let result: any;
            try {
              // Delegate to gemini-2.5-flash for Google Maps tool and stream the response
              const mapsResponseStream = await ai.models.generateContentStream({
                model: 'gemini-2.5-flash',
                contents: args.query,
                config: {
                  tools: [{ googleMaps: {} }]
                }
              });
              
              let fullText = '';
              let chunks: any[] = [];
              
              for await (const chunk of mapsResponseStream) {
                if (chunk.text) {
                  fullText += chunk.text;
                }
                if (chunk.candidates?.[0]?.groundingMetadata?.groundingChunks) {
                  chunks = chunk.candidates[0].groundingMetadata.groundingChunks;
                }
                
                // Update the tool call result in real-time
                setMessages((prev) => {
                  const newMessages = [...prev];
                  const lastMessage = newMessages[newMessages.length - 1];
                  if (lastMessage && lastMessage.toolCalls) {
                    const tc = lastMessage.toolCalls.find(t => t.name === call.name);
                    if (tc) tc.result = { text: fullText, places: chunks };
                  }
                  return newMessages;
                });
              }
              
              allMapsChunks.push(...chunks);
              result = {
                text: fullText,
                places: chunks
              };
            } catch (err) {
              result = { error: String(err) };
            }
            functionResponses.push({
              name: call.name,
              response: result,
              id: (call as any).id
            });
            
            setMessages((prev) => {
              const newMessages = [...prev];
              const lastMessage = newMessages[newMessages.length - 1];
              if (lastMessage && lastMessage.toolCalls) {
                const tc = lastMessage.toolCalls.find(t => t.name === call.name);
                if (tc) tc.result = result;
              }
              return newMessages;
            });
          }
        }

        // Send the results back to Gemini to get the final answer
        const followUpContents = [
          ...contents, 
          responseContent || {
            role: 'model',
            parts: functionCalls.map(call => ({
              functionCall: {
                name: call.name,
                args: call.args,
                id: (call as any).id
              }
            }))
          }, 
          {
            role: 'user',
            parts: functionResponses.map(fr => ({
              functionResponse: {
                name: fr.name,
                response: fr.response,
                id: fr.id
              }
            }))
          }
        ];

        setMessages((prev) => [...prev, { role: 'model', text: '', isThinking: true }]);

        const followUpConfig: any = {
          ...baseConfig
        };

        const followUpResponseStream = await ai.models.generateContentStream({
          model: selectedModel,
          contents: followUpContents,
          config: followUpConfig
        });

        setMessages((prev) => prev.filter((m) => !m.isThinking));
        
        // Add empty message for streaming follow-up
        setMessages((prev) => [...prev, { role: 'model', text: '' }]);
        
        modelText = '';
        let newChunks: any[] = [];

        for await (const chunk of followUpResponseStream) {
          if (chunk.text) {
            modelText += chunk.text;
            setMessages((prev) => {
              const newMessages = [...prev];
              newMessages[newMessages.length - 1].text = modelText;
              return newMessages;
            });
          }
          if (chunk.candidates?.[0]?.groundingMetadata?.groundingChunks) {
            newChunks = chunk.candidates[0].groundingMetadata.groundingChunks;
            groundingChunks = [...allMapsChunks, ...newChunks];
            setMessages((prev) => {
              const newMessages = [...prev];
              newMessages[newMessages.length - 1].groundingChunks = groundingChunks;
              return newMessages;
            });
          }
        }
      } else {
        // If there were no function calls, we already streamed the final message
      }

    } catch (error) {
      console.error('Error generating content:', error);
      setMessages((prev) => prev.filter((m) => !m.isThinking));
      setMessages((prev) => [
        ...prev,
        { role: 'model', text: `**Error:** ${error instanceof Error ? error.message : String(error)}` },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 font-sans">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-950/50 backdrop-blur-md sticky top-0 z-10 flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-emerald-500/10 rounded-lg">
            <Globe className="w-6 h-6 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-100">GeoAI Explorer</h1>
            <p className="text-xs text-zinc-400">Powered by Gemini 3.1 & Earth Engine</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center bg-zinc-900 rounded-lg p-1 border border-zinc-800">
            <button
              onClick={() => setSelectedModel('gemini-3.1-pro-preview')}
              className={cn("px-3 py-1.5 text-xs font-medium rounded-md transition-colors", selectedModel === 'gemini-3.1-pro-preview' ? "bg-zinc-800 text-zinc-100 shadow-sm" : "text-zinc-400 hover:text-zinc-200")}
            >
              3.1 Pro
            </button>
            <button
              onClick={() => setSelectedModel('gemini-3-flash-preview')}
              className={cn("px-3 py-1.5 text-xs font-medium rounded-md transition-colors", selectedModel === 'gemini-3-flash-preview' ? "bg-zinc-800 text-zinc-100 shadow-sm" : "text-zinc-400 hover:text-zinc-200")}
            >
              3.1 Flash
            </button>
          </div>
        </div>
      </header>

      {/* Chat Area */}
      <main className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center space-y-4 max-w-2xl mx-auto">
            <div className="p-4 bg-zinc-900 rounded-2xl border border-zinc-800 shadow-xl">
              <Globe className="w-12 h-12 text-emerald-500 mx-auto mb-4" />
              <h2 className="text-2xl font-medium text-zinc-100 mb-2">Earth Engine AI Assistant</h2>
              <p className="text-zinc-400 text-sm leading-relaxed">
                Upload satellite imagery, ask about environmental changes, or request geospatial analysis. 
                I use Google Earth Engine and Google Search to provide precise, data-driven answers.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full mt-8">
              <button onClick={() => setInput("Where is the recent forest fire located based on satellite data?")} className="p-3 text-sm text-left bg-zinc-900/50 hover:bg-zinc-800 border border-zinc-800 rounded-xl transition-colors">
                🔥 Locate recent forest fires
              </button>
              <button onClick={() => setInput("Show me the NDVI (vegetation index) changes in the Amazon over the last 5 years.")} className="p-3 text-sm text-left bg-zinc-900/50 hover:bg-zinc-800 border border-zinc-800 rounded-xl transition-colors">
                🌳 Analyze Amazon vegetation
              </button>
            </div>
          </div>
        ) : (
          <div className="max-w-4xl mx-auto space-y-6">
            {messages.map((msg, idx) => (
              <div
                key={idx}
                className={cn(
                  "flex gap-4",
                  msg.role === 'user' ? "justify-end" : "justify-start"
                )}
              >
                {msg.role === 'model' && (
                  <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0 border border-emerald-500/30">
                    <Globe className="w-4 h-4 text-emerald-400" />
                  </div>
                )}
                
                <div
                  className={cn(
                    "max-w-[85%] rounded-2xl p-4",
                    msg.role === 'user'
                      ? "bg-zinc-800 text-zinc-100"
                      : "bg-transparent text-zinc-300",
                    msg.isThinking && "animate-pulse opacity-70"
                  )}
                >
                  {msg.isThinking ? (
                    <div className="flex items-center gap-2 text-emerald-400">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span className="text-sm font-medium">Analyzing geospatial data...</span>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {/* Display uploaded files */}
                      {msg.files && msg.files.length > 0 && (
                        <div className="flex flex-wrap gap-2 mb-3">
                          {msg.files.map((file, i) => (
                            file.mimeType.startsWith('image/') ? (
                              <img 
                                key={i} 
                                src={`data:${file.mimeType};base64,${file.data}`} 
                                alt={file.name} 
                                className="max-w-xs rounded-lg border border-zinc-700 shadow-sm"
                              />
                            ) : (
                              <div key={i} className="flex items-center gap-2 p-2 bg-zinc-900 rounded-lg border border-zinc-700 text-sm">
                                <AlertCircle className="w-4 h-4 text-zinc-400" />
                                <span>{file.name}</span>
                              </div>
                            )
                          ))}
                        </div>
                      )}

                      {/* Display tool calls */}
                      {msg.toolCalls && msg.toolCalls.length > 0 && (
                        <div className="space-y-2">
                          {msg.toolCalls.map((call, i) => (
                            <div key={i} className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden text-sm">
                              <div className="flex items-center gap-2 px-3 py-2 bg-zinc-800/50 border-b border-zinc-800">
                                <Map className="w-4 h-4 text-emerald-400" />
                                <span className="font-mono text-zinc-300">Tool: {call.name}</span>
                              </div>
                              <div className="p-3 overflow-x-auto">
                                <pre className="text-xs text-zinc-400 font-mono">
                                  {JSON.stringify(call.args, null, 2)}
                                </pre>
                              </div>
                              {call.result && (
                                <div className="p-3 border-t border-zinc-800 bg-zinc-950 overflow-x-auto">
                                  <div className="text-xs text-zinc-500 mb-1 uppercase tracking-wider">Result</div>
                                  {call.name === 'searchGoogleMaps' && call.result.text !== undefined ? (
                                    <div className="prose prose-invert prose-emerald max-w-none prose-p:leading-relaxed prose-sm">
                                      {call.result.text ? (
                                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                          {call.result.text}
                                        </ReactMarkdown>
                                      ) : (
                                        <div className="flex items-center gap-2 text-emerald-400/80">
                                          <Loader2 className="w-3 h-3 animate-spin" />
                                          <span>Searching Maps...</span>
                                        </div>
                                      )}
                                    </div>
                                  ) : call.result.status === 'running' ? (
                                    <div className="flex items-center gap-2 text-emerald-400/80 text-sm">
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                      <span>Executing query...</span>
                                    </div>
                                  ) : (
                                    <pre className="text-xs text-emerald-400/80 font-mono">
                                      {call.result.error ? `Error: ${call.result.error}` : JSON.stringify(call.result, null, 2).slice(0, 500) + (JSON.stringify(call.result).length > 500 ? '...' : '')}
                                    </pre>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Display text content */}
                      {msg.text !== undefined && (msg.text || (msg.role === 'model' && !msg.toolCalls && !msg.isThinking)) && (
                        <div className="prose prose-invert prose-emerald max-w-none prose-p:leading-relaxed prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-800">
                          {msg.text ? (
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {msg.text}
                            </ReactMarkdown>
                          ) : (
                            <div className="flex items-center gap-2 text-emerald-400/80 text-sm font-medium">
                              <Loader2 className="w-4 h-4 animate-spin" />
                              <span>Thinking...</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Display grounding chunks */}
                      {msg.groundingChunks && msg.groundingChunks.length > 0 && (
                        <div className="mt-4 pt-4 border-t border-zinc-800/50">
                          <div className="text-xs text-zinc-500 mb-2 flex items-center gap-1">
                            <Search className="w-3 h-3" /> Sources
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {msg.groundingChunks.map((chunk, i) => {
                              const web = chunk.web;
                              const maps = chunk.maps;
                              if (web) {
                                return (
                                  <a key={i} href={web.uri} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 hover:underline bg-emerald-400/10 px-2 py-1 rounded border border-emerald-400/20 transition-colors">
                                    <Globe className="w-3 h-3" />
                                    <span className="truncate max-w-[200px]">{web.title || web.uri}</span>
                                  </a>
                                );
                              }
                              if (maps) {
                                return (
                                  <a key={i} href={maps.uri} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 hover:underline bg-blue-400/10 px-2 py-1 rounded border border-blue-400/20 transition-colors">
                                    <Map className="w-3 h-3" />
                                    <span className="truncate max-w-[200px]">{maps.title || 'Google Maps'}</span>
                                  </a>
                                );
                              }
                              return null;
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {msg.role === 'user' && (
                  <div className="w-8 h-8 rounded-full bg-zinc-700 flex items-center justify-center shrink-0">
                    <span className="text-xs font-medium">U</span>
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </main>

      {/* Input Area */}
      <footer className="p-4 sm:p-6 bg-zinc-950 border-t border-zinc-800">
        <div className="max-w-4xl mx-auto">
          {selectedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {selectedFiles.map((file, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded-full text-xs text-zinc-300">
                  <ImageIcon className="w-3 h-3" />
                  <span className="truncate max-w-[150px]">{file.name}</span>
                  <button 
                    onClick={() => setSelectedFiles(prev => prev.filter((_, idx) => idx !== i))}
                    className="ml-1 hover:text-red-400"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}
          
          <form onSubmit={handleSubmit} className="relative flex items-end gap-2">
            <div className="relative flex-1 bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden focus-within:border-emerald-500/50 focus-within:ring-1 focus-within:ring-emerald-500/50 transition-all">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about geospatial data, upload satellite images, or request Earth Engine analysis..."
                className="w-full max-h-48 min-h-[56px] bg-transparent text-zinc-100 placeholder-zinc-500 p-4 pr-12 resize-none focus:outline-none"
                rows={1}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit(e);
                  }
                }}
              />
              <div className="absolute right-2 bottom-2 flex items-center gap-1">
                <label className="p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-xl cursor-pointer transition-colors">
                  <ImageIcon className="w-5 h-5" />
                  <input 
                    type="file" 
                    multiple 
                    accept="image/*,video/*,audio/*" 
                    className="hidden" 
                    onChange={handleFileSelect}
                  />
                </label>
              </div>
            </div>
            <button
              type="submit"
              disabled={isLoading || (!input.trim() && selectedFiles.length === 0)}
              className="p-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0 flex items-center justify-center"
            >
              {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
            </button>
          </form>
          <div className="text-center mt-3">
            <p className="text-[10px] text-zinc-500">
              Gemini 3.1 can make mistakes. Verify critical geospatial analysis. Earth Engine requires proper credentials in .env.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

