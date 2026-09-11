/** Shared result shapes and errors for the query layer. */

                       
             
               
               
                   
                      
 

                          
               
               
                 
               
                      
                       
                   
 

export class ChatNotFoundError extends Error {}

export class AmbiguousChatError extends Error {
           matches          ;
  constructor(term        , matches          ) {
    const shown = matches.slice(0, 8).join(", ");
    super(
      `${matches.length} chats match ${JSON.stringify(term)}: ${shown}` +
        (matches.length > 8 ? "…" : ""),
    );
    this.matches = matches;
  }
}
